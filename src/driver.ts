import { mediapipeName } from "./ict.js";
import type { LandmarkModel } from "./landmarkModel.js";
import {
  LinearFitter, BoundedRidge, OneEuro, similarity, applySimilarity, transpose, defaultFitOptions,
  type FitOptions, type Mat3,
} from "./solver.js";
import { RIGID_LANDMARKS, FACE_OVAL_LANDMARKS, LIP_LANDMARKS, type TrackFrame } from "./mpConstants.js";

export interface DriveOptions extends FitOptions {
  /** Full-face landmark refinement of all expression weights. */
  refine: boolean;
  /** Fit mouth/jaw shapes to lip landmark motion relative to the calibrated neutral. */
  lipSync: boolean;
  /** Multiplier on MediaPipe scores (after removing the neutral baseline). */
  gain: number;
  /** Extra multiplier for mouth and jaw scores, which MediaPipe under-reports during speech. */
  mouthGain: number;
  /** Multiplier on measured lip motion before fitting (exaggeration). */
  lipGain: number;
  /** How strongly the lip fit sticks to MediaPipe's scores (0 = landmarks only). */
  lipPrior: number;
  /** 0 = raw, 0.9 = very smooth. */
  smoothing: number;
  /** Strength of the microphone speech assist (only used when a level is supplied). */
  micGain: number;
}

export const defaultDriveOptions: DriveOptions = {
  ...defaultFitOptions,
  min: 0,
  max: 1,
  temporal: 0.3,
  regularization: 0.01,
  refine: false,
  lipSync: true,
  gain: 1.2,
  mouthGain: 2,
  lipGain: 1.8,
  lipPrior: 0.15,
  smoothing: 0.35,
  micGain: 1,
};

/** Chin and lower-face points that move with the jaw, besides the lips. */
const JAW_LANDMARKS = [152, 148, 176, 149, 150, 377, 400, 378, 379, 175, 199, 200, 18, 83, 313, 182, 406, 57, 287, 212, 432, 202, 422];
const CALIBRATION_FRAMES = 45;

const isMouthShape = (name: string) => /^(jaw|mouth|cheekPuff)/.test(name);

/**
 * Turns MediaPipe results into ICT expression weights + head rotation.
 *
 * 1. MediaPipe's ARKit scores map 1:1 onto ICT's expressions, with the user's
 *    neutral baseline removed and a per-channel gain.
 * 2. Lip-sync: mouth/jaw weights are re-solved from how far the lip and chin
 *    landmarks moved from the calibrated neutral face (in the model's frame),
 *    using the scores as a prior. Speech produces small score changes but
 *    clear landmark motion, so this is what makes talking visible.
 * 3. A One Euro filter smooths still faces without lagging fast lip motion.
 *
 * It only needs the landmark-level model (LandmarkModel), not the render mesh.
 */
export class FaceDriver {
  /** ICT expression weights (filtered), in `expressionNames` order. */
  readonly weights: Float32Array;
  /** Head rotation, model frame -> camera frame (row-major 3x3), from the last update(). */
  headRotation: Mat3 | null = null;
  rmse = 0;
  /** 0..1 while calibrating, 1 when done. */
  calibration = 0;
  /** Microphone speech envelope 0..1 for the next update, or 0 when unused. */
  speech = 0;
  /** Inner-lip gap change from the calibrated neutral, in model millimetres (diagnostic). */
  lipGapMm = 0;
  private speechShapes: number[] = [];
  private innerLip: number[] = [];
  /** Similarity mapping this frame's observation (camera pixels) into the model frame. */
  lastSim: { s: number; R: Mat3; t: Float64Array } | null = null;

  /** For each ICT expression, the MediaPipe blendshape name (or null if MediaPipe has none). */
  readonly sources: (string | null)[];
  private mouthExpr: number[];
  private mouthLm: number[]; // indices into the model landmarks

  private fitter: LinearFitter;
  private lipSolver: BoundedRidge;
  private lipLamScale: Float32Array;
  private basis: Float32Array;
  private lmWeights: Float32Array;
  private rigid: Uint32Array;
  private baseLm: Float32Array;
  private observed: Float32Array;
  private aligned: Float32Array;
  private modelLm: Float32Array;
  private prior: Float32Array;
  private target: Float32Array;
  private filter: OneEuro;
  // Per-frame scratch for the lip fit and the filter (update() runs at video rate).
  private lipY: Float32Array;
  private lipPriorBuf: Float32Array;
  private nonMouth: Float32Array;
  private neutralModel: Float32Array;
  private savedCutoff: Float32Array;

  private baseline: Float32Array;
  private neutralLm: Float32Array;
  private calibFrames = 0;
  private calibScores: Float64Array;
  private calibObs: Float64Array;
  /** Average raw observation of the neutral face (camera frame), set by calibration. */
  private rawNeutral: Float32Array | null = null;
  private identityFitter: LinearFitter | null = null;

  /**
   * @param lm landmark-level model (LandmarkModel.load() or LandmarkModel.fromIct()); the driver
   *   reads its identity-adjusted `base`, and fitIdentity()/setIdentity() update it.
   * @param mediapipeNames the blendshape category names the tracker reports (MEDIAPIPE_BLENDSHAPES).
   */
  constructor(readonly lm: LandmarkModel, mediapipeNames: readonly string[]) {
    const nL = lm.count, nE = lm.nE;

    const oval = new Set(FACE_OVAL_LANDMARKS);
    const lips = new Set(LIP_LANDMARKS);
    const jaw = new Set(JAW_LANDMARKS);
    this.lmWeights = new Float32Array(nL);
    const rigid: number[] = [];
    this.mouthLm = [];
    this.lm.mpIndex.forEach((mp, l) => {
      this.lmWeights[l] = oval.has(mp) ? 0.3 : 1;
      if (RIGID_LANDMARKS.includes(mp)) rigid.push(l);
      if (lips.has(mp) || jaw.has(mp)) this.mouthLm.push(l);
    });
    if (rigid.length < 4) throw new Error("landmark embedding is missing the rigid upper-face points");
    this.rigid = Uint32Array.from(rigid);
    this.basis = lm.expressionBasis;
    this.fitter = new LinearFitter(this.basis, nE, this.lmWeights, this.rigid);

    const known = new Set(mediapipeNames);
    // ICT splits a few shapes MediaPipe reports once (browInnerUp, cheekPuff): drive both halves.
    this.sources = lm.expressionNames.map((n) =>
      [mediapipeName(n), n.replace(/_[LR]$/, "")].find((c) => known.has(c)) ?? null,
    );

    // Lip-sync subproblem: mouth expressions x mouth landmarks.
    // cheekPuff is left to MediaPipe: in a landmark fit it soaks up jaw motion.
    this.mouthExpr = lm.expressionNames.flatMap((n, e) => (/^(jaw|mouth)/.test(n) && this.sources[e] ? [e] : []));
    const m3 = this.mouthLm.length * 3;
    const B = new Float32Array(this.mouthExpr.length * m3);
    this.mouthExpr.forEach((e, r) => {
      this.mouthLm.forEach((l, j) => {
        for (let c = 0; c < 3; c++) B[r * m3 + j * 3 + c] = this.basis[e * nL * 3 + l * 3 + c];
      });
    });
    const W = new Float32Array(m3);
    // MediaPipe's z (depth) is much noisier than x/y, so it counts less.
    this.mouthLm.forEach((l, j) => {
      const w = lips.has(this.lm.mpIndex[l]) ? 1 : 0.5;
      W[j * 3] = w; W[j * 3 + 1] = w; W[j * 3 + 2] = 0.25 * w;
    });
    this.lipSolver = new BoundedRidge(B, this.mouthExpr.length, W);
    // Sideways/forward jaw and mouth shifts are rare in speech but can absorb fit error: damp them.
    this.lipLamScale = Float32Array.from(this.mouthExpr, (e) =>
      /^(jawForward|jawLeft|jawRight|mouthLeft|mouthRight)$/.test(lm.expressionNames[e]) ? 40 : 1,
    );

    // Speech assist opens the jaw and drops the lower lip.
    this.speechShapes = ["jawOpen", "mouthLowerDown_L", "mouthLowerDown_R"].map((n) => lm.expressionNames.indexOf(n));
    this.innerLip = [13, 14].map((mp) => Array.from(this.lm.mpIndex).indexOf(mp));

    const minCutoff = Float32Array.from(lm.expressionNames, (n) => (isMouthShape(n) ? 6 : 1.2));
    // Speech is 4-6 syllables/s: the derivative estimate must keep up (dCutoff 6 Hz) or it averages out.
    this.filter = new OneEuro(nE, minCutoff, 3, 6);

    this.weights = new Float32Array(nE);
    this.prior = new Float32Array(nE);
    this.target = new Float32Array(nE);
    this.baseline = new Float32Array(nE);
    this.calibScores = new Float64Array(nE);
    this.baseLm = new Float32Array(nL * 3);
    this.observed = new Float32Array(nL * 3);
    this.aligned = new Float32Array(nL * 3);
    this.modelLm = new Float32Array(nL * 3);
    this.neutralLm = new Float32Array(nL * 3);
    this.calibObs = new Float64Array(nL * 3);
    this.lipY = new Float32Array(this.mouthLm.length * 3);
    this.lipPriorBuf = new Float32Array(this.mouthExpr.length);
    this.nonMouth = new Float32Array(nE);
    this.neutralModel = new Float32Array(nL * 3);
    this.savedCutoff = new Float32Array(nE);
    this.identityChanged();
  }

  /** ICT expression names, the order of `weights` and `sources`. */
  get expressionNames(): string[] { return this.lm.expressionNames; }

  get calibrated(): boolean { return this.calibration >= 1; }

  /** Starts a neutral-face calibration over the next ~1.5 s of tracked frames. */
  calibrate(): void {
    this.calibration = 0;
    this.calibFrames = 0;
    this.calibScores.fill(0);
    this.calibObs.fill(0);
  }

  /**
   * Applies identity coefficients (N(0,1) PCA weights) to the landmark model and re-derives the
   * calibrated neutral. The render mesh is separate: apply the same coefficients to it yourself.
   */
  setIdentity(coeffs: ArrayLike<number>): void {
    this.lm.setIdentity(coeffs);
    this.identityChanged();
  }

  /** Re-reads the landmark model's base. Call after changing it directly with lm.setIdentity(). */
  identityChanged(): void {
    this.baseLm.set(this.lm.base);
    this.updateNeutral();
  }

  /** Neutral landmarks in the model frame, from the raw calibration observation. */
  private updateNeutral(): void {
    if (!this.rawNeutral) return;
    const sim = similarity(this.rawNeutral, this.baseLm, this.lmWeights, this.rigid);
    applySimilarity(sim, this.rawNeutral, this.neutralLm);
  }

  /**
   * Fits ICT identity coefficients (N(0,1) PCA weights) to the calibrated
   * neutral face and applies them to the landmark model (as setIdentity()).
   * Returns the coefficients, or null until calibration has finished.
   * Apply them to the render mesh yourself (IctModel.setIdentity()).
   */
  fitIdentity(regularization = 0.05): Float32Array | null {
    if (!this.rawNeutral) return null;
    const m = this.lm, nL = m.count;
    if (!m.nI) return new Float32Array(0);
    if (!this.identityFitter) {
      const all = Uint32Array.from({ length: nL }, (_, i) => i);
      this.identityFitter = new LinearFitter(m.identityBasis, m.nI, this.lmWeights, all);
    }
    const fit = this.identityFitter.fit(m.neutral, this.rawNeutral, new Float32Array(m.nI), {
      regularization, temporal: 0, min: -3, max: 3, iterations: 4,
    });
    this.setIdentity(fit.coeffs);
    return fit.coeffs;
  }

  update(frame: TrackFrame, opt: DriveOptions = defaultDriveOptions, track = true, tSec = performance.now() / 1000): void {
    const nE = this.lm.nE;
    const raw = (e: number) => (this.sources[e] ? frame.blendshapes[this.sources[e]!] ?? 0 : 0);

    // 1. Scores -> prior weights, relative to the user's neutral.
    for (let e = 0; e < nE; e++) {
      const b = this.baseline[e];
      const s = Math.max(0, raw(e) - b) / Math.max(0.05, 1 - b);
      const g = opt.gain * (isMouthShape(this.lm.expressionNames[e]) ? opt.mouthGain : 1);
      this.prior[e] = Math.min(1, s * g);
    }

    // 2. Head pose: align observed landmarks to the model on rigid upper-face points.
    this.lm.mpIndex.forEach((mp, l) => {
      this.observed[l * 3] = frame.points[mp * 3];
      this.observed[l * 3 + 1] = frame.points[mp * 3 + 1];
      this.observed[l * 3 + 2] = frame.points[mp * 3 + 2];
    });
    this.target.set(this.prior);
    if (opt.refine) {
      const fit = this.fitter.fit(this.baseLm, this.observed, this.prior, opt);
      this.target.set(fit.coeffs);
    }
    this.modelLandmarks(this.target, this.modelLm);
    const sim = similarity(this.observed, this.modelLm, this.lmWeights, this.rigid);
    applySimilarity(sim, this.observed, this.aligned);
    this.lastSim = sim;
    this.headRotation = transpose(sim.R);
    this.rmse = this.residual();

    // 3. Calibration: average scores and aligned landmarks of a relaxed face.
    if (!this.calibrated) {
      for (let e = 0; e < nE; e++) this.calibScores[e] += raw(e);
      for (let i = 0; i < this.observed.length; i++) this.calibObs[i] += this.observed[i];
      this.calibFrames++;
      this.calibration = this.calibFrames / CALIBRATION_FRAMES;
      if (this.calibrated) {
        for (let e = 0; e < nE; e++) this.baseline[e] = Math.min(0.5, this.calibScores[e] / this.calibFrames);
        this.rawNeutral = Float32Array.from(this.calibObs, (x) => x / this.calibFrames);
        this.updateNeutral();
      }
    }

    // 4. Lip-sync: solve mouth shapes from lip/chin motion relative to neutral.
    if (opt.lipSync && this.calibrated) {
      const y = this.lipY;
      const neutralModel = this.neutralModel;
      // Expression-independent part of the model: neutral face + non-mouth shapes.
      const nonMouth = this.nonMouth;
      nonMouth.set(this.target);
      for (const e of this.mouthExpr) nonMouth[e] = 0;
      this.modelLandmarks(nonMouth, neutralModel);
      this.mouthLm.forEach((l, j) => {
        for (let c = 0; c < 3; c++) {
          const i = l * 3 + c;
          // Measured motion from the user's neutral, exaggerated by lipGain, minus what non-mouth shapes explain.
          y[j * 3 + c] = opt.lipGain * (this.aligned[i] - this.neutralLm[i]) - (neutralModel[i] - this.baseLm[i]);
        }
      });
      const prior = this.lipPriorBuf;
      for (let r = 0; r < this.mouthExpr.length; r++) prior[r] = this.target[this.mouthExpr[r]];
      const w = this.lipSolver.solve(y, prior, 0.005, opt.lipPrior, 0, 1, this.lipLamScale);
      this.mouthExpr.forEach((e, r) => (this.target[e] = w[r]));
    }

    if (this.calibrated && this.innerLip.every((l) => l >= 0)) {
      const [u, l] = this.innerLip;
      const gap = (a: Float32Array) => a[u * 3 + 1] - a[l * 3 + 1];
      this.lipGapMm = (gap(this.aligned) - gap(this.neutralLm)) * 1000;
    }

    // 5. Microphone assist: open the mouth with speech energy where vision under-reports.
    if (this.speech > 0) {
      const [jaw, ldL, ldR] = this.speechShapes;
      const a = this.speech * opt.micGain;
      if (jaw >= 0) this.target[jaw] = Math.max(this.target[jaw], Math.min(1, 0.22 * a));
      for (const e of [ldL, ldR]) if (e >= 0) this.target[e] = Math.max(this.target[e], Math.min(1, 0.4 * a));
    }

    // 6. Temporal filtering.
    if (track) {
      const scale = 1 / (0.15 + 2.4 * opt.smoothing); // smoothing 0.35 -> ~1x base cutoff
      const cut = this.filter.minCutoff;
      const saved = this.savedCutoff;
      saved.set(cut);
      for (let e = 0; e < nE; e++) cut[e] *= scale;
      this.filter.filter(this.target, tSec, this.weights);
      cut.set(saved);
    }
  }

  private modelLandmarks(w: Float32Array, out: Float32Array): void {
    const n3 = out.length;
    out.set(this.baseLm);
    for (let e = 0; e < w.length; e++) {
      if (!w[e]) continue;
      for (let i = 0; i < n3; i++) out[i] += w[e] * this.basis[e * n3 + i];
    }
  }

  private residual(): number {
    let err = 0, W = 0;
    for (let l = 0; l < this.lm.count; l++) {
      for (let c = 0; c < 3; c++) err += this.lmWeights[l] * (this.aligned[l * 3 + c] - this.modelLm[l * 3 + c]) ** 2;
      W += this.lmWeights[l];
    }
    return Math.sqrt(err / W);
  }
}
