import { LandmarkSampler, type IctModel } from "./ict.js";

/** Layout of ict-landmarks.json (written by tools/convert_ict.py). */
export interface LandmarkModelMeta {
  format: "likeness-landmarks";
  version: 1;
  units: "m";
  expression_names: string[];
  n_identity: number;
  /** MediaPipe face-mesh index of each landmark the model has. */
  mediapipe_index: number[];
  /** Little-endian float32 arrays in ict-landmarks.bin: neutral (nL,3), expressions (nE,nL,3), identities (nI,nL,3). */
  arrays: Record<"neutral" | "expressions" | "identities", { dtype: "float32"; offset: number; shape: number[] }>;
}

/**
 * The ICT-FaceKit morphable model sampled at the MediaPipe landmarks: all the
 * face driver needs, without the 26k-vertex render mesh (~0.4 MB instead of 11 MB).
 *
 * Model frame: metres, y up, the face looking down +z (x is the subject's left).
 * All per-landmark arrays are landmark-major xyz: landmark l, axis c is at [l * 3 + c].
 */
export class LandmarkModel {
  /** ICT expression names (e.g. "jawOpen", "mouthSmile_L"), in basis order. */
  readonly expressionNames: string[];
  /** MediaPipe landmark index of each model landmark. */
  readonly mpIndex: Uint32Array;
  /** Neutral landmark positions without identity (count * 3). */
  readonly neutral: Float32Array;
  /** Expression deltas at the landmarks: nE rows of count * 3. */
  readonly expressionBasis: Float32Array;
  /** Identity deltas at the landmarks: nI rows of count * 3 (coefficients are N(0,1) PCA weights). */
  readonly identityBasis: Float32Array;
  /** Neutral + identity (count * 3); updated by setIdentity(). */
  readonly base: Float32Array;
  /** The identity coefficients currently applied to `base`. */
  readonly identity: Float32Array;

  constructor(init: {
    expressionNames: string[];
    mpIndex: Uint32Array;
    neutral: Float32Array;
    expressionBasis: Float32Array;
    identityBasis: Float32Array;
  }) {
    this.expressionNames = init.expressionNames;
    this.mpIndex = init.mpIndex;
    this.neutral = init.neutral;
    this.expressionBasis = init.expressionBasis;
    this.identityBasis = init.identityBasis;
    const n3 = this.neutral.length;
    if (n3 !== this.mpIndex.length * 3) throw new Error("landmark model: neutral size does not match the landmark count");
    if (this.expressionBasis.length !== this.nE * n3) throw new Error("landmark model: expression basis has the wrong size");
    if (this.identityBasis.length % n3) throw new Error("landmark model: identity basis has the wrong size");
    this.base = Float32Array.from(this.neutral);
    this.identity = new Float32Array(this.identityBasis.length / n3);
  }

  /** Number of landmarks. */
  get count(): number { return this.mpIndex.length; }
  /** Number of expressions. */
  get nE(): number { return this.expressionNames.length; }
  /** Number of identity components. */
  get nI(): number { return this.identity.length; }

  /** Expression e's deltas (count * 3), a view into expressionBasis. */
  expression(e: number): Float32Array {
    const n3 = this.count * 3;
    return this.expressionBasis.subarray(e * n3, (e + 1) * n3);
  }

  /** Identity component k's deltas (count * 3), a view into identityBasis. */
  identityComponent(k: number): Float32Array {
    const n3 = this.count * 3;
    return this.identityBasis.subarray(k * n3, (k + 1) * n3);
  }

  /** base = neutral + Σ coeffs_k · identity_k. Extra coefficients are ignored, missing ones are 0. */
  setIdentity(coeffs: ArrayLike<number>): void {
    this.identity.fill(0);
    this.base.set(this.neutral);
    for (let k = 0; k < Math.min(coeffs.length, this.nI); k++) {
      const c = coeffs[k];
      this.identity[k] = c;
      if (c === 0) continue;
      const d = this.identityComponent(k);
      for (let i = 0; i < d.length; i++) this.base[i] += c * d[i];
    }
  }

  /** Builds the model from ict-landmarks.json and the contents of ict-landmarks.bin. */
  static parse(meta: LandmarkModelMeta, bin: ArrayBuffer): LandmarkModel {
    if (meta.format !== "likeness-landmarks") throw new Error("not a likeness landmark model (ict-landmarks.json)");
    const view = (name: keyof LandmarkModelMeta["arrays"]) => {
      const a = meta.arrays[name];
      if (!a) throw new Error(`ict-landmarks.bin is missing array "${name}"`);
      // Copy: the offset may not be 4-byte aligned relative to a sliced buffer, and the caller may reuse it.
      return new Float32Array(bin.slice(a.offset, a.offset + a.shape.reduce((x, y) => x * y, 1) * 4));
    };
    return new LandmarkModel({
      expressionNames: meta.expression_names,
      mpIndex: Uint32Array.from(meta.mediapipe_index),
      neutral: view("neutral"),
      expressionBasis: view("expressions"),
      identityBasis: view("identities"),
    });
  }

  /** Loads `${baseUrl}/ict-landmarks.json` and its .bin. Throws on a missing or invalid file. */
  static async load(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<LandmarkModel> {
    const base = baseUrl.replace(/\/+$/, "");
    const metaRes = await fetchFn(`${base}/ict-landmarks.json`);
    const hint = "Copy dist/lib/assets into your public folder and call setAssetBase(), or pass modelUrl.";
    // Dev servers often answer missing files with index.html (HTTP 200), so check the type too.
    if (!metaRes.ok || (metaRes.headers?.get("content-type") ?? "json").includes("html")) {
      throw new Error(`likeness: could not load ${base}/ict-landmarks.json (HTTP ${metaRes.status}). ${hint}`);
    }
    const meta = (await metaRes.json()) as LandmarkModelMeta;
    const binRes = await fetchFn(`${base}/ict-landmarks.bin`);
    if (!binRes.ok) throw new Error(`likeness: could not load ${base}/ict-landmarks.bin (HTTP ${binRes.status}). ${hint}`);
    return LandmarkModel.parse(meta, await binRes.arrayBuffer());
  }

  /**
   * Samples a loaded full ICT model at its landmark embedding (same data as the lite file).
   * Starts at zero identity, whatever model.base holds: call setIdentity() to match it.
   */
  static fromIct(model: IctModel): LandmarkModel {
    const sampler = new LandmarkSampler(model);
    const neutral = new Float32Array(sampler.count * 3);
    sampler.sample(model.neutral, neutral);
    return new LandmarkModel({
      expressionNames: model.expressionNames.slice(),
      mpIndex: Uint32Array.from(sampler.mpIndex),
      neutral,
      expressionBasis: sampler.expressionBasis(model),
      identityBasis: sampler.denseBasis(model.identities),
    });
  }
}
