// CPU side of the texture capture: which vertices to light-fit and mirror,
// per-frame lighting samples, frame gating and the resolve-time fill.
// Pure TypeScript (no DOM, no three.js) so it is unit-tested in Node.

import type { IctModel } from "./ict.js";
import { SRGB_TO_LINEAR_8 } from "./sh.js";

export interface Sim { s: number; R: ArrayLike<number>; t: ArrayLike<number> }

/** Per-mesh data the baker needs beyond plain geometry. Build it with prepareBakeMesh(). */
export interface BakeMesh {
  /** Render vertices used for the lighting fit (clean skin: no eyes, brows, lips, nostrils, hair). */
  lightVerts: Uint32Array;
  /** Render vertices splatted into the CPU depth buffer (one per position vertex of the skin). */
  occluderVerts: Uint32Array;
  /** Packed uv (u, v) pairs on cheeks and forehead, for the median skin tone. */
  skinRefUv: Float32Array;
  /**
   * Mirror map, non-indexed triangles: per corner (u, v, mirrorU, mirrorV) in
   * packed uv. Each skin triangle is drawn at its own uv and carries the uv of
   * the mirrored surface point. Empty when unavailable.
   */
  mirrorTris: Float32Array;
}

// MediaPipe landmark ids (embedded on the ICT surface) used to carve regions.
const EXCLUDE: [number[], number][] = [
  [[33, 133, 159, 145], 0.017], // right eye (subject's)
  [[263, 362, 386, 374], 0.017], // left eye
  [[70, 105, 107, 46, 53], 0.014], // brows
  [[300, 334, 336, 276, 283], 0.014],
  [[61, 291, 13, 14, 0, 17, 40, 270, 91, 321], 0.012], // lips
  [[98, 327, 2, 79, 309], 0.009], // nostrils
];
const SKIN_REF: [number[], number][] = [
  [[50, 280, 101, 330], 0.016], // cheeks
  [[151, 108, 337], 0.018], // forehead
];

function landmarkPos(model: IctModel, mp: number): [number, number, number] | null {
  const lm = model.meta.landmarks;
  if (!lm.valid[mp]) return null;
  const f = lm.faces[mp];
  const p: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = model.tris[f * 3 + c];
    for (let k = 0; k < 3; k++) p[k] += lm.bary[mp][c] * model.neutral[v * 3 + k];
  }
  return p;
}

function regionSpheres(model: IctModel, spec: [number[], number][]): number[][] {
  const out: number[][] = [];
  for (const [ids, r] of spec) for (const id of ids) {
    const p = landmarkPos(model, id);
    if (p) out.push([p[0], p[1], p[2], r]);
  }
  return out;
}

const inAny = (spheres: number[][], x: number, y: number, z: number) =>
  spheres.some(([a, b, c, r]) => (x - a) ** 2 + (y - b) ** 2 + (z - c) ** 2 < r * r);

/**
 * Builds the BakeMesh for the ICT model.
 * @param index triangle indices of the bake geometry (render vertices, skin only)
 * @param uv packed uv of the bake geometry (nRender*2; face tile in u<0.5)
 */
export function prepareBakeMesh(model: IctModel, index: ArrayLike<number>, uv: ArrayLike<number>, maxLight = 1500): BakeMesh {
  const P = model.neutral, uvV = model.uvVertex;
  const faceEnd = model.meta.parts.face?.verts[1] ?? model.nV;
  const exclude = regionSpheres(model, EXCLUDE), ref = regionSpheres(model, SKIN_REF);
  // Forehead top (hairline) and chin bottom from landmarks 10 and 152.
  const top = landmarkPos(model, 10)?.[1] ?? Infinity, bottom = landmarkPos(model, 152)?.[1] ?? -Infinity;

  // One render vertex per skin position vertex.
  const firstRender = new Int32Array(model.nV).fill(-1);
  const renderOf: number[][] = [];
  for (let i = 0; i < index.length; i++) {
    const r = index[i], v = uvV[r];
    if (firstRender[v] < 0) firstRender[v] = r;
    (renderOf[v] ??= []).includes(r) || renderOf[v].push(r);
  }

  const light: number[] = [], occ: number[] = [], refUv: number[] = [];
  for (let v = 0; v < model.nV; v++) {
    const r = firstRender[v];
    if (r < 0) continue;
    occ.push(r);
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (v >= faceEnd || uv[r * 2] >= 0.5) continue;
    if (inAny(ref, x, y, z)) refUv.push(uv[r * 2], uv[r * 2 + 1]);
    if (y > top - 0.008 || y < bottom + 0.004 || inAny(exclude, x, y, z)) continue;
    if (model.neutralNormals[v * 3 + 2] < -0.2) continue; // back of the face part (ear/jaw underside)
    light.push(r);
  }
  const stride = Math.max(1, Math.ceil(light.length / maxLight));
  const lightVerts = Uint32Array.from(light.filter((_, i) => i % stride === 0));

  return {
    lightVerts,
    occluderVerts: Uint32Array.from(occ),
    skinRefUv: Float32Array.from(refUv),
    mirrorTris: buildMirrorTris(model, index, uv, renderOf),
  };
}

/** Nearest position vertex to the x-reflection of each skin vertex (spatial hash, 3 mm cells). */
export function mirrorVertices(model: IctModel, isSkin: (v: number) => boolean, maxDist = 0.002): Int32Array {
  const P = model.neutral, cell = 0.003;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let v = 0; v < model.nV; v++) {
    if (!isSkin(v)) continue;
    const k = key(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(v);
  }
  const out = new Int32Array(model.nV).fill(-1);
  for (let v = 0; v < model.nV; v++) {
    if (!isSkin(v)) continue;
    const x = -P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = maxDist * maxDist, bi = -1;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      for (const w of list) {
        const d = (P[w * 3] - x) ** 2 + (P[w * 3 + 1] - y) ** 2 + (P[w * 3 + 2] - z) ** 2;
        if (d < best) { best = d; bi = w; }
      }
    }
    out[v] = bi;
  }
  return out;
}

function buildMirrorTris(model: IctModel, index: ArrayLike<number>, uv: ArrayLike<number>, renderOf: number[][]): Float32Array {
  const mirror = mirrorVertices(model, (v) => !!renderOf[v]);
  const out: number[] = [];
  const best = [0, 0, 0];
  const per = (a: number, b: number, c: number) =>
    Math.hypot(uv[a * 2] - uv[b * 2], uv[a * 2 + 1] - uv[b * 2 + 1]) +
    Math.hypot(uv[b * 2] - uv[c * 2], uv[b * 2 + 1] - uv[c * 2 + 1]) +
    Math.hypot(uv[c * 2] - uv[a * 2], uv[c * 2 + 1] - uv[a * 2 + 1]);
  for (let f = 0; f < index.length; f += 3) {
    const own = [index[f], index[f + 1], index[f + 2]];
    const cand = own.map((r) => renderOf[mirror[model.uvVertex[r]]] ?? []);
    if (cand.some((c) => !c.length)) continue;
    // Mirror vertices on a uv seam have several render vertices: pick the most compact uv triangle.
    let bestP = Infinity;
    for (const a of cand[0]) for (const b of cand[1]) for (const c of cand[2]) {
      const p = per(a, b, c);
      if (p < bestP) { bestP = p; best[0] = a; best[1] = b; best[2] = c; }
    }
    const ownP = per(own[0], own[1], own[2]);
    if (!(bestP < ownP * 2 + 1e-6 && bestP > ownP * 0.5 - 1e-6)) continue; // straddles a seam
    const tile = uv[best[0] * 2] >= 0.5;
    if ((uv[best[1] * 2] >= 0.5) !== tile || (uv[best[2] * 2] >= 0.5) !== tile) continue;
    for (let k = 0; k < 3; k++) out.push(uv[own[k] * 2], uv[own[k] * 2 + 1], uv[best[k] * 2], uv[best[k] * 2 + 1]);
  }
  return Float32Array.from(out);
}

/** Fallback when no BakeMesh is given: face-tile vertices of the index as light samples, no mirror. */
export function genericBakeMesh(index: ArrayLike<number>, uv: ArrayLike<number>, maxLight = 1500): BakeMesh {
  const seen = new Set<number>();
  for (let i = 0; i < index.length; i++) seen.add(index[i]);
  const all = Array.from(seen).sort((a, b) => a - b);
  const face = all.filter((r) => uv[r * 2] < 0.5);
  const stride = Math.max(1, Math.ceil(face.length / maxLight));
  return {
    lightVerts: Uint32Array.from(face.filter((_, i) => i % stride === 0)),
    occluderVerts: Uint32Array.from(all),
    skinRefUv: new Float32Array(0),
    mirrorTris: new Float32Array(0),
  };
}

// --- per-frame lighting samples ------------------------------------------------

export interface Image8 { data: ArrayLike<number>; width: number; height: number }

export interface LightSamples {
  normals: Float32Array;
  colors: Float32Array;
  count: number;
}

export class LightSampler {
  private zbuf = new Float32Array(0);
  private zw = 0;
  private zh = 0;
  readonly out: LightSamples;

  constructor(maxSamples: number) {
    this.out = { normals: new Float32Array(maxSamples * 3), colors: new Float32Array(maxSamples * 3), count: 0 };
  }

  /**
   * Projects the light vertices into `img` (a downscaled copy of the video,
   * rows top to bottom) and returns visible, front-facing, unsaturated
   * samples: camera-frame unit normals and linear colours.
   *
   * @param pos, nrm geometry attributes (render vertices, model frame; normals need not be unit)
   * @param videoW, videoH size of the full video in pixels (the projection's units)
   */
  sample(
    pos: ArrayLike<number>, nrm: ArrayLike<number>, mesh: BakeMesh, sim: Sim,
    videoW: number, videoH: number, img: Image8, minFacing = 0.3,
  ): LightSamples {
    const { s, R, t } = sim;
    const W = img.width, H = img.height;
    // Depth buffer at half the sample resolution so the vertex splats leave no holes.
    const zw = Math.max(1, W >> 1), zh = Math.max(1, H >> 1);
    if (this.zw !== zw || this.zh !== zh) { this.zbuf = new Float32Array(zw * zh); this.zw = zw; this.zh = zh; }
    const zbuf = this.zbuf;
    zbuf.fill(-Infinity);
    const inv = 1 / s;
    const occ = mesh.occluderVerts;
    for (let i = 0; i < occ.length; i++) {
      const r = occ[i] * 3;
      const px = pos[r] - t[0], py = pos[r + 1] - t[1], pz = pos[r + 2] - t[2];
      const ox = (R[0] * px + R[3] * py + R[6] * pz) * inv;
      const oy = (R[1] * px + R[4] * py + R[7] * pz) * inv;
      const oz = (R[2] * px + R[5] * py + R[8] * pz) * inv;
      const ix = Math.floor((ox / videoW + 0.5) * zw), iy = Math.floor((0.5 - oy / videoH) * zh);
      if (ix < 0 || iy < 0 || ix >= zw || iy >= zh) continue;
      const k = iy * zw + ix;
      if (oz > zbuf[k]) zbuf[k] = oz;
    }

    const tol = 0.006 * inv; // 6 mm, in video pixels
    const lv = mesh.lightVerts, out = this.out, data = img.data;
    const maxN = out.normals.length / 3;
    let n = 0;
    for (let i = 0; i < lv.length && n < maxN; i++) {
      const r = lv[i] * 3;
      // n_cam = R^T n
      const nx0 = nrm[r], ny0 = nrm[r + 1], nz0 = nrm[r + 2];
      let nx = R[0] * nx0 + R[3] * ny0 + R[6] * nz0;
      let ny = R[1] * nx0 + R[4] * ny0 + R[7] * nz0;
      let nz = R[2] * nx0 + R[5] * ny0 + R[8] * nz0;
      const l = Math.hypot(nx, ny, nz);
      if (!(l > 0)) continue;
      nx /= l; ny /= l; nz /= l;
      if (nz < minFacing) continue;
      const px = pos[r] - t[0], py = pos[r + 1] - t[1], pz = pos[r + 2] - t[2];
      const ox = (R[0] * px + R[3] * py + R[6] * pz) * inv;
      const oy = (R[1] * px + R[4] * py + R[7] * pz) * inv;
      const oz = (R[2] * px + R[5] * py + R[8] * pz) * inv;
      const u = (ox / videoW + 0.5), v = (0.5 - oy / videoH);
      if (u < 0.01 || v < 0.01 || u > 0.99 || v > 0.99) continue;
      const zx = Math.min(zw - 1, Math.floor(u * zw)), zy = Math.min(zh - 1, Math.floor(v * zh));
      if (oz < zbuf[zy * zw + zx] - tol) continue; // occluded
      // Bilinear sample (pixel centres at +0.5).
      const fx = u * W - 0.5, fy = v * H - 0.5;
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(H - 2, Math.floor(fy)));
      const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      let sat = false, dark = 0;
      for (let c = 0; c < 3; c++) {
        const a = data[i00 + c], b = data[i10 + c], cc = data[i01 + c], d = data[i11 + c];
        if (a >= 250 || b >= 250 || cc >= 250 || d >= 250) sat = true;
        const lin = (SRGB_TO_LINEAR_8[a] * (1 - ax) + SRGB_TO_LINEAR_8[b] * ax) * (1 - ay)
          + (SRGB_TO_LINEAR_8[cc] * (1 - ax) + SRGB_TO_LINEAR_8[d] * ax) * ay;
        out.colors[n * 3 + c] = lin;
        dark += lin;
      }
      if (sat || dark < 0.006) continue;
      out.normals[n * 3] = nx; out.normals[n * 3 + 1] = ny; out.normals[n * 3 + 2] = nz;
      n++;
    }
    out.count = n;
    return out;
  }
}

// --- frame gating -----------------------------------------------------------------

/** Angle (radians) of the relative rotation between two row-major 3x3 rotations. */
export function rotationAngle(A: ArrayLike<number>, B: ArrayLike<number>): number {
  let tr = 0;
  for (let i = 0; i < 9; i++) tr += A[i] * B[i]; // trace(A^T B)
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}

/** Camera-pixel position of a model-frame point. */
export function toCamera(sim: Sim, x: number, y: number, z: number, out: number[] = [0, 0, 0]): number[] {
  const { s, R, t } = sim;
  const px = x - t[0], py = y - t[1], pz = z - t[2];
  out[0] = (R[0] * px + R[3] * py + R[6] * pz) / s;
  out[1] = (R[1] * px + R[4] * py + R[7] * pz) / s;
  out[2] = (R[2] * px + R[5] * py + R[8] * pz) / s;
  return out;
}

// --- resolve-time post-process -----------------------------------------------------------

/** Per-channel median of the sRGB bytes at texels with alpha >= minAlpha (histogram, exact). */
export function medianColor(px: Uint8Array | Uint8ClampedArray, texels: ArrayLike<number>, minAlpha: number): [number, number, number] | null {
  const hist = new Uint32Array(3 * 256);
  let n = 0;
  for (let k = 0; k < texels.length; k++) {
    const i = texels[k] * 4;
    if (px[i + 3] < minAlpha) continue;
    hist[px[i]]++; hist[256 + px[i + 1]]++; hist[512 + px[i + 2]]++;
    n++;
  }
  if (n < 16) return null;
  const med: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0, v = 0;
    while (v < 255 && (acc += hist[c * 256 + v]) < n / 2) v++;
    med[c] = v;
  }
  return med;
}

/** Texel indices (row-major, v=0 first row) for packed uvs, including a 3x3 neighbourhood. */
export function texelsAt(uv: Float32Array, w: number, h: number): Uint32Array {
  const out: number[] = [];
  for (let k = 0; k < uv.length; k += 2) {
    const x = Math.floor(uv[k] * w), y = Math.floor(uv[k + 1] * h);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out.push(yy * w + xx);
    }
  }
  return Uint32Array.from(out);
}

export interface FillOptions {
  /** Feather width in texels: how far unseen areas blend from the nearest seen colour to the skin tone. */
  feather: number;
  /** Block size of the low-resolution fill map. */
  block: number;
}
export const defaultFillOptions: FillOptions = { feather: 48, block: 4 };

/**
 * Composites `px` (sRGB bytes, alpha = confidence) over a smooth fill and
 * writes opaque RGBA into `out`. The fill map is built at 1/block resolution:
 * seen blocks keep their own (confidence-weighted) colour, unseen blocks take
 * the nearest seen colour and fade to `skin` over `feather` texels, then the
 * map is box-blurred and upsampled bilinearly. Low-confidence texels therefore
 * blend into a soft local colour instead of a hard edge, and UV gutters are
 * filled so mipmaps and bilinear lookups don't bleed dark seams.
 */
export function featherFill(
  px: Uint8Array | Uint8ClampedArray, w: number, h: number, skin: [number, number, number],
  out: Uint8ClampedArray | Uint8Array, opt: FillOptions = defaultFillOptions,
): void {
  const B = opt.block, cw = Math.ceil(w / B), ch = Math.ceil(h / B), nc = cw * ch;
  const sum = new Float32Array(nc * 4);
  for (let y = 0; y < h; y++) {
    const row = (y / B | 0) * cw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = px[i + 3];
      if (!a) continue;
      const k = (row + (x / B | 0)) * 4;
      sum[k] += px[i] * a; sum[k + 1] += px[i + 1] * a; sum[k + 2] += px[i + 2] * a; sum[k + 3] += a;
    }
  }
  // Nearest seen block for every block: two-pass vector propagation (8 neighbours).
  const seed = new Int32Array(nc).fill(-1);
  const dist = new Float32Array(nc).fill(Infinity);
  for (let k = 0; k < nc; k++) if (sum[k * 4 + 3] > 0) { seed[k] = k; dist[k] = 0; }
  const relax = (k: number, j: number) => {
    const s = seed[j];
    if (s < 0) return;
    const dx = (s % cw) - (k % cw), dy = ((s / cw) | 0) - ((k / cw) | 0);
    const d = dx * dx + dy * dy;
    if (d < dist[k]) { dist[k] = d; seed[k] = s; }
  };
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const k = y * cw + x;
    if (x > 0) relax(k, k - 1);
    if (y > 0) { relax(k, k - cw); if (x > 0) relax(k, k - cw - 1); if (x < cw - 1) relax(k, k - cw + 1); }
  }
  for (let y = ch - 1; y >= 0; y--) for (let x = cw - 1; x >= 0; x--) {
    const k = y * cw + x;
    if (x < cw - 1) relax(k, k + 1);
    if (y < ch - 1) { relax(k, k + cw); if (x < cw - 1) relax(k, k + cw + 1); if (x > 0) relax(k, k + cw - 1); }
  }
  const fill = new Float32Array(nc * 3);
  const F = opt.feather / B;
  for (let k = 0; k < nc; k++) {
    const s = seed[k];
    if (s < 0) { fill[k * 3] = skin[0]; fill[k * 3 + 1] = skin[1]; fill[k * 3 + 2] = skin[2]; continue; }
    const a = sum[s * 4 + 3];
    const t = Math.min(1, Math.sqrt(dist[k]) / F), f = t * t * (3 - 2 * t); // smoothstep
    for (let c = 0; c < 3; c++) fill[k * 3 + c] = (sum[s * 4 + c] / a) * (1 - f) + skin[c] * f;
  }
  // Two separable 3-tap box blurs soften the Voronoi edges of the nearest-colour propagation.
  const tmp = new Float32Array(nc * 3);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const xa = x > 0 ? x - 1 : x, xb = x < cw - 1 ? x + 1 : x;
      for (let c = 0; c < 3; c++) tmp[(y * cw + x) * 3 + c] = (fill[(y * cw + xa) * 3 + c] + fill[(y * cw + x) * 3 + c] + fill[(y * cw + xb) * 3 + c]) / 3;
    }
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const ya = y > 0 ? y - 1 : y, yb = y < ch - 1 ? y + 1 : y;
      for (let c = 0; c < 3; c++) fill[(y * cw + x) * 3 + c] = (tmp[(ya * cw + x) * 3 + c] + tmp[(y * cw + x) * 3 + c] + tmp[(yb * cw + x) * 3 + c]) / 3;
    }
  }

  // Composite with a bilinear upsample of the fill map (fully seen texels are copied as is).
  const colX0 = new Int32Array(w), colX1 = new Int32Array(w), colAx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.max(0, Math.min(cw - 1.001, (x + 0.5) / B - 0.5));
    colX0[x] = (fx | 0) * 3; colX1[x] = Math.min(cw - 1, (fx | 0) + 1) * 3; colAx[x] = fx - (fx | 0);
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(ch - 1.001, (y + 0.5) / B - 0.5));
    const y0 = fy | 0, ay = fy - y0, r0 = y0 * cw * 3, r1 = Math.min(ch - 1, y0 + 1) * cw * 3;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a8 = px[i + 3];
      out[i + 3] = 255;
      if (a8 === 255) { out[i] = px[i]; out[i + 1] = px[i + 1]; out[i + 2] = px[i + 2]; continue; }
      const a = a8 / 255, x0 = colX0[x], x1 = colX1[x], ax = colAx[x];
      const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
      for (let c = 0; c < 3; c++) {
        const f = fill[r0 + x0 + c] * w00 + fill[r0 + x1 + c] * w10 + fill[r1 + x0 + c] * w01 + fill[r1 + x1 + c] * w11;
        out[i + c] = px[i + c] * a + f * (1 - a);
      }
    }
  }
}
