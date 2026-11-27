// ICT-FaceKit morphable face model (USC ICT Vision & Graphics Lab, MIT licence):
// neutral mesh + linear identity shapes + 53 ARKit-style expression blendshapes.
// Expressions are stored sparse and evaluated on the CPU each frame.

interface ArrayInfo { dtype: "float32" | "uint32" | "uint16" | "int16" | "int8"; offset: number; shape: number[] }

const ARRAY_TYPES = { float32: Float32Array, uint32: Uint32Array, uint16: Uint16Array, int16: Int16Array, int8: Int8Array };

export interface IctMeta {
  n_verts: number;
  n_tris: number;
  n_render_verts: number;
  expression_names: string[];
  n_identity: number;
  parts: Record<string, { verts: [number, number]; tris: [number, number] }>;
  arrays: Record<string, ArrayInfo>;
  expr_scales: number[];
  expr_normal_scales: number[];
  id_scales: number[];
  landmarks: { faces: number[]; bary: number[][]; valid: boolean[]; residual_mm: number[] };
}

interface SparseShape { index: Uint32Array; delta: Float32Array; normal: Float32Array }

/** Render-vertex (UV-split) copies of the base mesh and the expressions, for evaluateRender(). */
interface RenderShapes {
  base: Float32Array;
  normals: Float32Array;
  /** Per expression: render-vertex offsets (r * 3) and their deltas, 3 per offset. */
  expressions: { offset: Uint32Array; delta: Float32Array; normal: Float32Array }[];
  baseVersion: number;
}

export class IctModel {
  readonly nV: number;
  readonly nE: number;
  readonly nI: number;
  readonly expressionNames: string[];
  readonly tris: Uint32Array;
  readonly neutral: Float32Array;
  readonly neutralNormals: Float32Array;
  /** Render vertices (position vertex split at UV seams). */
  readonly nRender: number;
  readonly uv: Float32Array;
  readonly uvVertex: Uint32Array;
  readonly uvTris: Uint32Array;
  readonly expressions: SparseShape[] = [];
  /** Dense identity deltas, one Float32Array of nV*3 per identity. */
  readonly identities: Float32Array[] = [];

  /** Neutral + identity; updated by setIdentity. */
  readonly base: Float32Array;
  readonly baseNormals: Float32Array;
  /** Bumped when base or baseNormals change, so evaluateRender() re-gathers them. */
  private baseVersion = 0;
  private renderShapes: RenderShapes | null = null;

  constructor(readonly meta: IctMeta, buf: ArrayBuffer) {
    // Arrays are stored at their own dtype (indices as uint16 when they fit, normal deltas as int8):
    // read them as stored, widening indices to Uint32Array.
    const raw = (name: string) => {
      const a = meta.arrays[name];
      if (!a) throw new Error(`ict.bin is missing array "${name}"`);
      const Ctor = ARRAY_TYPES[a.dtype];
      if (!Ctor) throw new Error(`ict.bin array "${name}" has unsupported dtype ${a.dtype}`);
      return new Ctor(buf, a.offset, a.shape.reduce((x, y) => x * y, 1));
    };
    const view = <T extends Float32Array | Uint32Array | Int16Array>(name: string, Ctor: new (b: ArrayBuffer, o: number, n: number) => T): T => {
      const a = raw(name);
      if (a instanceof Ctor) return a;
      if (Ctor === (Uint32Array as unknown) && (a instanceof Uint16Array)) return Uint32Array.from(a) as T;
      throw new Error(`ict.bin array "${name}" is ${meta.arrays[name].dtype}, expected ${Ctor.name}`);
    };
    this.nV = meta.n_verts;
    this.expressionNames = meta.expression_names;
    this.nE = this.expressionNames.length;
    this.nI = meta.n_identity;
    this.neutral = view("neutral", Float32Array);
    this.neutralNormals = view("normals", Float32Array);
    this.tris = view("tris", Uint32Array);
    this.nRender = meta.n_render_verts;
    this.uv = view("uv", Float32Array);
    this.uvVertex = view("uv_vertex", Uint32Array);
    this.uvTris = view("uv_tris", Uint32Array);

    const ptr = view("expr_ptr", Uint32Array);
    const index = view("expr_index", Uint32Array);
    const delta = view("expr_delta", Int16Array);
    const ndelta = raw("expr_normal_delta"); // int16, or int8 since the 8-bit export
    for (let e = 0; e < this.nE; e++) {
      const a = ptr[e], b = ptr[e + 1];
      const s = meta.expr_scales[e], ns = meta.expr_normal_scales[e];
      const d = new Float32Array((b - a) * 3), n = new Float32Array((b - a) * 3);
      for (let i = 0; i < d.length; i++) {
        d[i] = delta[a * 3 + i] * s;
        n[i] = ndelta[a * 3 + i] * ns;
      }
      this.expressions.push({ index: index.slice(a, b), delta: d, normal: n });
    }

    const id = view("id_delta", Int16Array);
    const n3 = this.nV * 3;
    for (let k = 0; k < this.nI; k++) {
      const out = new Float32Array(n3), s = meta.id_scales[k];
      for (let i = 0; i < n3; i++) out[i] = id[k * n3 + i] * s;
      this.identities.push(out);
    }

    this.base = Float32Array.from(this.neutral);
    this.baseNormals = Float32Array.from(this.neutralNormals);
  }

  static async load(baseUrl: string): Promise<IctModel | null> {
    const metaRes = await fetch(`${baseUrl}/ict.json`);
    if (!metaRes.ok || !(metaRes.headers.get("content-type") ?? "").includes("json")) return null;
    const meta = (await metaRes.json()) as IctMeta;
    const bin = await fetch(`${baseUrl}/ict.bin`);
    if (!bin.ok) return null;
    return new IctModel(meta, await bin.arrayBuffer());
  }

  /** Applies identity coefficients to the base mesh. Normals must be recomputed by the caller. */
  setIdentity(coeffs: ArrayLike<number>): void {
    this.baseVersion++;
    this.base.set(this.neutral);
    for (let k = 0; k < Math.min(coeffs.length, this.nI); k++) {
      const c = coeffs[k];
      if (c === 0) continue;
      const d = this.identities[k];
      for (let i = 0; i < d.length; i++) this.base[i] += c * d[i];
    }
  }

  /** Area-weighted vertex normals of `positions` (nV*3) over the position topology. */
  computeNormals(positions: Float32Array, out: Float32Array): void {
    if (out === this.baseNormals) this.baseVersion++;
    out.fill(0);
    const t = this.tris;
    for (let f = 0; f < t.length; f += 3) {
      const a = t[f] * 3, b = t[f + 1] * 3, c = t[f + 2] * 3;
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) { out[i] += nx; out[i + 1] += ny; out[i + 2] += nz; }
    }
    for (let i = 0; i < out.length; i += 3) {
      const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
      out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
    }
  }

  /** Copies per-position-vertex data (nV*k) to per-render-vertex data (nRender*k). */
  gather(src: Float32Array, out: Float32Array, k = 3): void {
    const map = this.uvVertex;
    for (let r = 0; r < map.length; r++) {
      const v = map[r] * k;
      for (let c = 0; c < k; c++) out[r * k + c] = src[v + c];
    }
  }

  /** Writes base + sum_e w_e * delta_e into positions and normals (normals left unnormalised). */
  evaluate(weights: ArrayLike<number>, positions: Float32Array, normals?: Float32Array): void {
    positions.set(this.base);
    normals?.set(this.baseNormals);
    for (let e = 0; e < this.nE; e++) {
      const w = weights[e];
      if (!w) continue;
      const { index, delta, normal } = this.expressions[e];
      for (let j = 0; j < index.length; j++) {
        const v = index[j] * 3;
        positions[v] += w * delta[j * 3];
        positions[v + 1] += w * delta[j * 3 + 1];
        positions[v + 2] += w * delta[j * 3 + 2];
        if (normals) {
          normals[v] += w * normal[j * 3];
          normals[v + 1] += w * normal[j * 3 + 1];
          normals[v + 2] += w * normal[j * 3 + 2];
        }
      }
    }
  }

  /**
   * evaluate() + gather() in one pass, straight into render-vertex buffers (nRender*3): base +
   * sum_e w_e * delta_e, normals left unnormalised. Expressions with |w| < minWeight are skipped
   * (1e-3 moves a vertex by microns).
   */
  evaluateRender(weights: ArrayLike<number>, positions: Float32Array, normals: Float32Array, minWeight = 1e-3): void {
    const R = this.renderData();
    positions.set(R.base);
    normals.set(R.normals);
    for (let e = 0; e < this.nE; e++) {
      const w = weights[e];
      if (!(w >= minWeight || w <= -minWeight)) continue;
      const { offset, delta, normal } = R.expressions[e];
      for (let j = 0, k = 0; j < offset.length; j++, k += 3) {
        const o = offset[j];
        positions[o] += w * delta[k];
        positions[o + 1] += w * delta[k + 1];
        positions[o + 2] += w * delta[k + 2];
        normals[o] += w * normal[k];
        normals[o + 1] += w * normal[k + 1];
        normals[o + 2] += w * normal[k + 2];
      }
    }
  }

  private renderData(): RenderShapes {
    let R = this.renderShapes;
    if (!R) {
      // Position vertex -> its render vertices (CSR), to expand the sparse expressions once.
      const map = this.uvVertex, nR = map.length;
      const start = new Uint32Array(this.nV + 1);
      for (let r = 0; r < nR; r++) start[map[r] + 1]++;
      for (let v = 0; v < this.nV; v++) start[v + 1] += start[v];
      const fill = start.slice(0, this.nV), renderOf = new Uint32Array(nR);
      for (let r = 0; r < nR; r++) renderOf[fill[map[r]]++] = r;
      const expressions = this.expressions.map(({ index, delta, normal }) => {
        let n = 0;
        for (let j = 0; j < index.length; j++) n += start[index[j] + 1] - start[index[j]];
        const out = { offset: new Uint32Array(n), delta: new Float32Array(n * 3), normal: new Float32Array(n * 3) };
        let i = 0;
        for (let j = 0; j < index.length; j++) {
          for (let s = start[index[j]]; s < start[index[j] + 1]; s++, i++) {
            out.offset[i] = renderOf[s] * 3;
            for (let c = 0; c < 3; c++) {
              out.delta[i * 3 + c] = delta[j * 3 + c];
              out.normal[i * 3 + c] = normal[j * 3 + c];
            }
          }
        }
        return out;
      });
      R = this.renderShapes = { base: new Float32Array(nR * 3), normals: new Float32Array(nR * 3), expressions, baseVersion: -1 };
    }
    if (R.baseVersion !== this.baseVersion) {
      this.gather(this.base, R.base);
      this.gather(this.baseNormals, R.normals);
      R.baseVersion = this.baseVersion;
    }
    return R;
  }
}

/** MediaPipe landmarks embedded on the ICT surface (face index + barycentrics). */
export class LandmarkSampler {
  /** MediaPipe landmark index for each fitted landmark. */
  readonly mpIndex: Uint32Array;
  private corners: Uint32Array; // per landmark: 3 vertex indices
  private bary: Float32Array;

  constructor(model: IctModel) {
    const lm = model.meta.landmarks;
    const ids: number[] = [];
    lm.valid.forEach((ok, i) => ok && ids.push(i));
    this.mpIndex = Uint32Array.from(ids);
    this.corners = new Uint32Array(ids.length * 3);
    this.bary = new Float32Array(ids.length * 3);
    ids.forEach((mp, l) => {
      const f = lm.faces[mp];
      for (let c = 0; c < 3; c++) {
        this.corners[l * 3 + c] = model.tris[f * 3 + c];
        this.bary[l * 3 + c] = lm.bary[mp][c];
      }
    });
  }

  get count(): number { return this.mpIndex.length; }

  /** Interpolates landmark positions from a full vertex array (nV*3). */
  sample(verts: ArrayLike<number>, out: Float32Array): void {
    for (let l = 0; l < this.count; l++) {
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let b = 0; b < 3; b++) v += this.bary[l * 3 + b] * verts[this.corners[l * 3 + b] * 3 + c];
        out[l * 3 + c] = v;
      }
    }
  }

  /** Samples dense per-vertex fields (each nV*3) at the landmarks: rows of count*3. */
  denseBasis(fields: Float32Array[]): Float32Array {
    const nL3 = this.count * 3;
    const out = new Float32Array(fields.length * nL3);
    fields.forEach((f, k) => this.sample(f, out.subarray(k * nL3, (k + 1) * nL3)));
    return out;
  }

  /** Expression basis at the landmarks: nE rows of count*3. */
  expressionBasis(model: IctModel): Float32Array {
    const nL3 = this.count * 3;
    const dense = new Float32Array(model.nV * 3);
    const out = new Float32Array(model.nE * nL3);
    model.expressions.forEach(({ index, delta }, e) => {
      dense.fill(0);
      for (let j = 0; j < index.length; j++) {
        dense[index[j] * 3] = delta[j * 3];
        dense[index[j] * 3 + 1] = delta[j * 3 + 1];
        dense[index[j] * 3 + 2] = delta[j * 3 + 2];
      }
      this.sample(dense, out.subarray(e * nL3, (e + 1) * nL3));
    });
    return out;
  }
}

/** ICT name ("browDown_L") -> MediaPipe blendshape name ("browDownLeft"). */
export function mediapipeName(ictName: string): string {
  return ictName.replace(/_L$/, "Left").replace(/_R$/, "Right");
}
