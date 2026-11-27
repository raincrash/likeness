import { readFileSync } from "fs";
import { fitShading, ShadingNormalizer, shEval, shBrightness, linearToSrgb, defaultShFitOptions } from "../src/sh.js";
import { prepareBakeMesh, LightSampler, rotationAngle, featherFill, medianColor, toCamera } from "../src/bakecpu.js";
import { IctModel, type IctMeta } from "../src/ict.js";
import { quatToMat } from "../src/solver.js";

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${detail})`);
  if (!ok) failures++;
}
const time = (f: () => void, reps: number) => { const t0 = performance.now(); for (let i = 0; i < reps; i++) f(); return (performance.now() - t0) / reps; };

// A plausible room light (linear, per channel): warm key from upper left, cool fill, ambient.
const LIGHT = new Float64Array(27);
for (let c = 0; c < 3; c++) {
  const tint = [1.0, 0.9, 0.8][c];
  const o = c * 9;
  LIGHT[o] = 2.2 * tint; LIGHT[o + 1] = 0.5 * tint; LIGHT[o + 2] = 0.6; LIGHT[o + 3] = -0.7 * tint;
  LIGHT[o + 4] = -0.12; LIGHT[o + 5] = 0.08; LIGHT[o + 6] = -0.15; LIGHT[o + 7] = -0.1 * tint; LIGHT[o + 8] = 0.05;
}
const ALBEDO = [0.62, 0.42, 0.33];

function hemisphereNormals(n: number, minZ = 0.15): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let x, y, z;
    do { x = rand() * 2 - 1; y = rand() * 2 - 1; z = rand(); } while (x * x + y * y + z * z > 1 || x * x + y * y + z * z < 0.05);
    const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
    if (z < minZ) { i--; continue; }
    out.set([x, y, z], i * 3);
  }
  return out;
}

function render(normals: Float32Array, n: number, albedo: (i: number, c: number) => number, gain = 1): Float32Array {
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    col[i * 3 + c] = gain * albedo(i, c) * shEval(LIGHT, c, normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
  }
  return col;
}

function delit(nz: ShadingNormalizer, normals: Float32Array, colors: Float32Array, i: number, c: number) {
  return colors[i * 3 + c] / nz.shading(c, normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
}

// 1. Exact round trip: no noise, no regularisation.
{
  const n = 1500, N = hemisphereNormals(n), C = render(N, n, (_, c) => ALBEDO[c]);
  const fit = fitShading(N, C, n, { band1: 0, band2: 0, iterations: 1 })!;
  let err = 0;
  for (let c = 0; c < 3; c++) for (let k = 0; k < 9; k++) err = Math.max(err, Math.abs(fit.coeffs[c * 9 + k] - ALBEDO[c] * LIGHT[c * 9 + k]));
  check("SH fit recovers albedo * light exactly", err < 1e-5, `max coeff err ${err.toExponential(1)}`);
  const nz = new ShadingNormalizer(0);
  nz.update(fit);
  let dev = 0;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) dev = Math.max(dev, Math.abs(delit(nz, N, C, i, c) / (ALBEDO[c] * shBrightness(LIGHT, c)) - 1));
  check("delit colour = albedo * mean irradiance", dev < 1e-5, `max rel dev ${dev.toExponential(1)}`);
}

// 2. Textured albedo + noise + outliers (brows, lips, highlights), default regularised robust fit.
{
  const n = 1500, N = hemisphereNormals(n);
  const pattern = Float32Array.from({ length: n }, () => 1 + (rand() - 0.5) * 0.12); // freckles / pores
  const kind = Uint8Array.from({ length: n }, () => { const r = rand(); return r < 0.08 ? 1 : r < 0.12 ? 2 : 0; });
  const alb = (i: number, c: number) => ALBEDO[c] * pattern[i] * (kind[i] === 1 ? 0.35 : 1);
  const C = render(N, n, alb);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    if (kind[i] === 2) C[i * 3 + c] += 0.5; // specular
    C[i * 3 + c] *= 1 + (rand() - 0.5) * 0.04;
  }
  const fit = fitShading(N, C, n)!;
  const nz = new ShadingNormalizer(0);
  nz.update(fit);
  // Ratio delit / true albedo should be the same for every clean sample (shading fully removed).
  const ratios: number[] = [], raw: number[] = [];
  for (let i = 0; i < n; i++) if (kind[i] === 0) {
    ratios.push(delit(nz, N, C, i, 1) / alb(i, 1));
    raw.push(C[i * 3 + 1] / alb(i, 1));
  }
  const cv = (a: number[]) => { const m = a.reduce((x, y) => x + y) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) / m; };
  check("robust fit removes shading", cv(ratios) < 0.04 && cv(ratios) < cv(raw) / 4, `CV after ${(cv(ratios) * 100).toFixed(1)}%, before ${(cv(raw) * 100).toFixed(1)}%, inliers ${fit.inliers.toFixed(0)}/${n}`);
  const ms = time(() => fitShading(N, C, n), 50);
  console.log(`     perf: fitShading ${ms.toFixed(3)} ms (1500 samples, ${defaultShFitOptions.iterations} IRLS iterations)`);
}

// 3. Exposure / auto-gain swing between frames cancels: the same surface seen in a frame that is 70%
// brighter delights to the same albedo.
{
  const n = 1200, N1 = hemisphereNormals(n), N2 = hemisphereNormals(n);
  const nz = new ShadingNormalizer(0.5);
  nz.update(fitShading(N1, render(N1, n, (_, c) => ALBEDO[c]), n)!);
  const C2 = render(N2, n, (_, c) => ALBEDO[c]);
  const before = Array.from({ length: n }, (_, i) => delit(nz, N2, C2, i, 0));
  const C2b = render(N2, n, (_, c) => ALBEDO[c], 1.7);
  nz.update(fitShading(N2, C2b, n)!);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(delit(nz, N2, C2b, i, 0) / before[i] - 1));
  check("exposure change cancels", worst < 0.02 && Math.abs(nz.gain[0] - 1.7) < 0.02, `gain ${nz.gain[0].toFixed(3)}, max rel dev ${(worst * 100).toFixed(2)}%`);
}

// 4. Rotation delta.
{
  const A = quatToMat(0.9, 0.1, 0.3, 0.05);
  const h = (5 * Math.PI) / 180 / 2;
  const dq = quatToMat(Math.cos(h), 0, Math.sin(h), 0); // 5 deg about y
  const B = new Float64Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) B[r * 3 + c] += A[r * 3 + k] * dq[k * 3 + c];
  const deg = (rotationAngle(A, B) * 180) / Math.PI;
  check("rotation delta", Math.abs(deg - 5) < 1e-6, `${deg.toFixed(6)} deg`);
}

// 5. Real ICT mesh: bake mesh preparation, mirror map, CPU lighting samples on a synthetic frame.
{
  const meta = JSON.parse(readFileSync("public/ict/ict.json", "utf8")) as IctMeta;
  const bin = readFileSync("public/ict/ict.bin");
  const model = new IctModel(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
  const nR = model.nRender;
  const uv = new Float32Array(nR * 2);
  for (let r = 0; r < nR; r++) { uv[r * 2] = model.uv[r * 2] / 2; uv[r * 2 + 1] = model.uv[r * 2 + 1]; }
  const index: number[] = [];
  for (const name of ["face", "head_neck"]) {
    const p = meta.parts[name];
    for (let t = p.tris[0] * 3; t < p.tris[1] * 3; t++) index.push(model.uvTris[t]);
  }
  let mesh = prepareBakeMesh(model, index, uv);
  const prepMs = time(() => { mesh = prepareBakeMesh(model, index, uv); }, 3);
  const nTris = index.length / 3, nMirror = mesh.mirrorTris.length / 12;
  check("mirror map covers the skin", nMirror > 0.9 * nTris, `${nMirror}/${nTris} triangles, prepare ${prepMs.toFixed(0)} ms`);
  // Mirror of a texel's mirror lands back near the texel: compare symmetric triangle pairs via centroid uv.
  let selfInverse = 0, tested = 0;
  const cent = new Map<string, [number, number]>();
  const mt = mesh.mirrorTris;
  for (let f = 0; f < mt.length; f += 12) {
    const ou = (mt[f] + mt[f + 4] + mt[f + 8]) / 3, ov = (mt[f + 1] + mt[f + 5] + mt[f + 9]) / 3;
    const mu = (mt[f + 2] + mt[f + 6] + mt[f + 10]) / 3, mv = (mt[f + 3] + mt[f + 7] + mt[f + 11]) / 3;
    cent.set(`${ou.toFixed(5)},${ov.toFixed(5)}`, [mu, mv]);
  }
  for (const [k, [mu, mv]] of cent) {
    if (tested > 3000) break;
    const back = cent.get(`${mu.toFixed(5)},${mv.toFixed(5)}`);
    tested++;
    if (back) { const [u0, v0] = k.split(",").map(Number); if (Math.hypot(back[0] - u0, back[1] - v0) < 1e-4) selfInverse++; }
  }
  check("mirror map is an involution", selfInverse > 0.8 * tested, `${selfInverse}/${tested} triangles map back to themselves`);
  check("light / skin-ref vertices", mesh.lightVerts.length > 500 && mesh.skinRefUv.length > 40,
    `${mesh.lightVerts.length} light verts, ${mesh.skinRefUv.length / 2} skin-ref verts, ${mesh.occluderVerts.length} occluders`);

  // Synthetic frame: head turned 25 deg, lit by LIGHT in camera space, rendered by splatting into 160x90.
  const pos = new Float32Array(nR * 3), nrm = new Float32Array(nR * 3), nrmV = new Float32Array(model.nV * 3);
  model.computeNormals(model.base, nrmV);
  model.gather(model.base, pos);
  model.gather(nrmV, nrm);
  const h = (25 * Math.PI) / 180 / 2;
  const sim = { s: 0.0004, R: quatToMat(Math.cos(h), 0.05, Math.sin(h), 0), t: Float64Array.from([0, 0.02, 0]) };
  const VW = 1280, VH = 720, W = 160, H = 90;
  const img = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  const zb = new Float64Array(W * H).fill(-Infinity);
  const o = [0, 0, 0];
  for (let pass = 0; pass < 2; pass++) for (let r = 0; r < nR; r++) {
    const v = model.uvVertex[r];
    if (v >= (meta.parts.head_neck.verts[1])) continue;
    toCamera(sim, pos[r * 3], pos[r * 3 + 1], pos[r * 3 + 2], o);
    const R = sim.R, n0 = nrm[r * 3], n1 = nrm[r * 3 + 1], n2 = nrm[r * 3 + 2];
    const nx = R[0] * n0 + R[3] * n1 + R[6] * n2, ny = R[1] * n0 + R[4] * n1 + R[7] * n2, nzz = R[2] * n0 + R[5] * n1 + R[8] * n2;
    const x = Math.floor((o[0] / VW + 0.5) * W), y = Math.floor((0.5 - o[1] / VH) * H);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const k = yy * W + xx;
      if (pass === 0) { zb[k] = Math.max(zb[k], o[2]); continue; }
      if (o[2] < zb[k] - 1e-6) continue;
      for (let c = 0; c < 3; c++) img.data[k * 4 + c] = Math.round(255 * linearToSrgb(Math.min(1, ALBEDO[c] * 0.5 * shEval(LIGHT, c, nx, ny, nzz))));
      img.data[k * 4 + 3] = 255;
    }
  }
  const sampler = new LightSampler(2000);
  const smp = sampler.sample(pos, nrm, mesh, sim, VW, VH, img);
  const fit = fitShading(smp.normals, smp.colors, smp.count)!;
  const nz = new ShadingNormalizer(0);
  nz.update(fit);
  // Shading shape (relative to the mean over the observed normals) vs the truth, at the observed normals:
  // this is the error left in the texture. The raw variation is what no delighting would leave.
  const est: number[] = [], tru: number[] = [];
  for (let i = 0; i < smp.count; i++) {
    const [x, y, z] = [smp.normals[i * 3], smp.normals[i * 3 + 1], smp.normals[i * 3 + 2]];
    est.push(nz.shading(1, x, y, z)); tru.push(shEval(LIGHT, 1, x, y, z));
  }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const me = mean(est), mtr = mean(tru);
  const errs = est.map((e, i) => Math.abs(e / me / (tru[i] / mtr) - 1)).sort((a, b) => a - b);
  const rawVar = mean(tru.map((t) => Math.abs(t / mtr - 1)));
  const errMean = mean(errs), err90 = errs[Math.floor(errs.length * 0.9)];
  check("lighting recovered from a synthetic ICT frame (160 px)", smp.count > 300 && errMean < 0.05 && err90 < 0.1 && errMean < rawVar / 3,
    `${smp.count} samples; shading error mean ${(errMean * 100).toFixed(1)}%, p90 ${(err90 * 100).toFixed(1)}%; raw shading variation ${(rawVar * 100).toFixed(1)}%`);
  const sampleMs = time(() => sampler.sample(pos, nrm, mesh, sim, VW, VH, img), 50);
  const fitMs = time(() => { const s = sampler.sample(pos, nrm, mesh, sim, VW, VH, img); nz.update(fitShading(s.normals, s.colors, s.count)!); }, 50);
  console.log(`     perf: CPU per accumulate (excl. drawImage/getImageData): sample ${sampleMs.toFixed(2)} ms, sample+fit ${fitMs.toFixed(2)} ms`);
}

// 6. Resolve post-process: feathered fill and median skin at 2048x1024.
{
  const w = 2048, h = 1024, px = new Uint8Array(w * h * 4), out = new Uint8ClampedArray(w * h * 4);
  // Covered disc in the face tile with a soft confidence edge; a few dark "brow" texels.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 512, y - 512) / 380, i = (y * w + x) * 4;
    if (d > 1) continue;
    px[i] = 190; px[i + 1] = 140; px[i + 2] = 120; px[i + 3] = Math.round(255 * Math.min(1, (1 - d) * 5));
    if (y > 300 && y < 320) { px[i] = 60; px[i + 1] = 40; px[i + 2] = 30; }
  }
  const tex: number[] = [];
  for (let y = 250; y < 800; y += 3) for (let x = 200; x < 800; x += 3) tex.push(y * w + x);
  const skin = medianColor(px, tex, 200)!;
  check("median skin ignores dark outliers", skin[0] === 190 && skin[1] === 140, `skin ${skin.join(",")}`);
  featherFill(px, w, h, [200, 150, 130], out); featherFill(px, w, h, [200, 150, 130], out); // JIT warm-up
  const ms = time(() => featherFill(px, w, h, [200, 150, 130], out), 5);
  const at = (x: number, y: number) => Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
  const centre = at(512, 600), edge = at(512 + 400, 512), far = at(1800, 900);
  check("feather fill", centre[0] === 190 && Math.abs(edge[0] - 190) < 8 && far[0] === 200,
    `seen ${centre}, 20 texels out ${edge}, far ${far}; ${ms.toFixed(1)} ms`);
  // Smoothness: no step larger than 3 levels along a row leaving the disc.
  let maxStep = 0;
  for (let x = 880; x < 1000; x++) maxStep = Math.max(maxStep, Math.abs(at(x + 1, 512)[0] - at(x, 512)[0]));
  check("fill falloff is smooth", maxStep <= 3, `max step ${maxStep}`);
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
