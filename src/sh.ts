// Second-order spherical-harmonic shading: basis, robust per-frame fit and
// exposure normalisation. Pure TypeScript (no DOM, no three.js) so it runs in
// Node tests as well as the browser.
//
// Model: linear colour c_i = albedo_i * shading(n_i), with shading(n) = L . Y(n)
// per RGB channel. With a mostly uniform albedo a, the fit recovers S = a L,
// i.e. shading up to an unknown per-channel scale. Dividing a frame by
// S(n) / ref (ref = a reference brightness) gives albedo_i * (ref / a), which
// is the same for every frame of a static scene however the camera's exposure
// or white balance drifts, because both S and the frame scale together.

/** Coefficient order: Y00, Y1-1 (y), Y10 (z), Y11 (x), Y2-2 (xy), Y2-1 (yz), Y20 (3z^2-1), Y21 (xz), Y22 (x^2-y^2). */
export const SH_COUNT = 9;
const C0 = 0.282095, C1 = 0.488603, C2 = 1.092548, C3 = 0.315392, C4 = 0.546274;

/** Writes the 9 real SH basis values of unit normal (x, y, z) into out[o..o+8]. */
export function shBasis(x: number, y: number, z: number, out: Float64Array | Float32Array, o = 0): void {
  out[o] = C0;
  out[o + 1] = C1 * y;
  out[o + 2] = C1 * z;
  out[o + 3] = C1 * x;
  out[o + 4] = C2 * x * y;
  out[o + 5] = C2 * y * z;
  out[o + 6] = C3 * (3 * z * z - 1);
  out[o + 7] = C2 * x * z;
  out[o + 8] = C4 * (x * x - y * y);
}

/** Evaluates channel `c` of coefficients (27 values, channel-major: c*9+k) at a unit normal. */
export function shEval(coeffs: ArrayLike<number>, c: number, x: number, y: number, z: number): number {
  const o = c * SH_COUNT;
  return coeffs[o] * C0 + C1 * (coeffs[o + 1] * y + coeffs[o + 2] * z + coeffs[o + 3] * x)
    + C2 * (coeffs[o + 4] * x * y + coeffs[o + 5] * y * z + coeffs[o + 7] * x * z)
    + C3 * coeffs[o + 6] * (3 * z * z - 1) + C4 * coeffs[o + 8] * (x * x - y * y);
}

/**
 * Mean of a channel's shading over the camera-facing hemisphere, weighted by
 * projected area (what the image of a convex object averages to). Only Y00,
 * Y10 and Y20 survive: E[z] = 2/3, E[3z^2 - 1] = 1/2 under cosine weighting.
 * Lights are fixed relative to the static camera, so this changes between
 * frames only with exposure / gain, which makes it the exposure reference.
 */
export function shBrightness(coeffs: ArrayLike<number>, c: number): number {
  const o = c * SH_COUNT;
  return C0 * coeffs[o] + C1 * (2 / 3) * coeffs[o + 2] + C3 * 0.5 * coeffs[o + 6];
}

export interface ShFitOptions {
  /** Ridge weight on band 1 (directional) coefficients, relative to the sample weight. */
  band1: number;
  /** Ridge weight on band 2 (quadratic) coefficients. */
  band2: number;
  /** IRLS iterations (Tukey biweight on the luminance residual); 1 = plain least squares. */
  iterations: number;
}

export const defaultShFitOptions: ShFitOptions = { band1: 0.001, band2: 0.008, iterations: 4 };

export interface ShFit {
  /** 27 coefficients, channel-major (c*9 + k), in the colours' units (linear). */
  coeffs: Float64Array;
  /** shBrightness per channel. */
  brightness: [number, number, number];
  /** Effective number of inliers (sum of final robust weights). */
  inliers: number;
  /** Robust relative RMS of the luminance residual. */
  residual: number;
}

const LUM = [0.2126, 0.7152, 0.0722];

/**
 * Fits shading S_c(n) = L_c . Y(n) to `colors` (linear RGB, n*3) at unit
 * `normals` (n*3), assuming a mostly uniform albedo. Outliers (brows, lips,
 * stubble, specular highlights) are down-weighted by IRLS on the luminance
 * residual; all channels share the weights and one 9x9 normal matrix.
 * Bands 1 and 2 are ridge-regularised towards 0 (uniform light), so poorly
 * constrained directions under-correct rather than blow up.
 */
export function fitShading(
  normals: ArrayLike<number>,
  colors: ArrayLike<number>,
  n: number,
  opt: ShFitOptions = defaultShFitOptions,
): ShFit | null {
  if (n < 12) return null;
  const Y = new Float64Array(n * SH_COUNT);
  for (let i = 0; i < n; i++) shBasis(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], Y, i * SH_COUNT);
  const w = new Float64Array(n).fill(1);
  const coeffs = new Float64Array(3 * SH_COUNT);
  const M = new Float64Array(SH_COUNT * SH_COUNT);
  const b = new Float64Array(3 * SH_COUNT);
  const ridge = [0, opt.band1, opt.band1, opt.band1, opt.band2, opt.band2, opt.band2, opt.band2, opt.band2];
  let residual = 0, W = n;

  for (let it = 0; it < Math.max(1, opt.iterations); it++) {
    M.fill(0); b.fill(0); W = 0;
    for (let i = 0; i < n; i++) {
      const wi = w[i];
      if (wi <= 0) continue;
      W += wi;
      const o = i * SH_COUNT;
      for (let r = 0; r < SH_COUNT; r++) {
        const yr = Y[o + r] * wi;
        for (let c = r; c < SH_COUNT; c++) M[r * SH_COUNT + c] += yr * Y[o + c];
        for (let ch = 0; ch < 3; ch++) b[ch * SH_COUNT + r] += yr * colors[i * 3 + ch];
      }
    }
    if (W < 12) return null;
    for (let r = 0; r < SH_COUNT; r++) {
      for (let c = 0; c < r; c++) M[r * SH_COUNT + c] = M[c * SH_COUNT + r];
      M[r * SH_COUNT + r] += ridge[r] * W + 1e-9 * W;
    }
    if (!choleskySolve(M, SH_COUNT, b, 3, coeffs)) return null;

    // Robust weights from the relative luminance residual (Tukey biweight, 4.685 * MAD scale).
    const rel = new Float64Array(n);
    let meanFit = 0;
    for (let i = 0; i < n; i++) {
      let fit = 0, obs = 0;
      for (let ch = 0; ch < 3; ch++) {
        let s = 0;
        for (let k = 0; k < SH_COUNT; k++) s += coeffs[ch * SH_COUNT + k] * Y[i * SH_COUNT + k];
        fit += LUM[ch] * s;
        obs += LUM[ch] * colors[i * 3 + ch];
      }
      meanFit += Math.max(fit, 0);
      rel[i] = obs - fit;
    }
    meanFit = Math.max(meanFit / n, 1e-6);
    for (let i = 0; i < n; i++) rel[i] /= meanFit;
    const abs = Array.from(rel, Math.abs).sort((x, y) => x - y);
    const mad = Math.max(abs[n >> 1] * 1.4826, 0.01);
    residual = mad;
    if (it === opt.iterations - 1) break;
    const cTukey = 4.685 * mad;
    for (let i = 0; i < n; i++) {
      const u = rel[i] / cTukey;
      w[i] = Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0;
    }
  }
  return {
    coeffs,
    brightness: [shBrightness(coeffs, 0), shBrightness(coeffs, 1), shBrightness(coeffs, 2)],
    inliers: W,
    residual,
  };
}

/** Solves A X = B for symmetric positive definite A (n x n) and m right-hand sides stored as m blocks of n. */
export function choleskySolve(A: Float64Array, n: number, B: Float64Array, m: number, out: Float64Array): boolean {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 0) return false;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let c = 0; c < m; c++) {
    for (let i = 0; i < n; i++) {
      let s = B[c * n + i];
      for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
      y[i] = s / L[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < n; k++) s -= L[k * n + i] * out[c * n + k];
      out[c * n + i] = s / L[i * n + i];
    }
  }
  return true;
}

/**
 * Turns per-frame fits into the shading each frame is divided by.
 *
 * - The first accepted frame fixes the reference brightness per channel, so
 *   the output is albedo * (that frame's mean irradiance): the colour balance
 *   of the scene, without its directional light.
 * - Each frame's shading is scaled by its own brightness, so exposure and
 *   auto-gain swings cancel.
 * - The light's *shape* (coefficients / brightness) is smoothed over frames
 *   (lights are static relative to the camera), which steadies the fit.
 */
export class ShadingNormalizer {
  /** Reference brightness per channel, set by the first frame after reset(). */
  ref: [number, number, number] | null = null;
  private shape: Float64Array | null = null;
  /** Normalised coefficients for the shader (divide linear colour by max(shading, min)). */
  readonly coeffs: Float64Array = new Float64Array(27);
  /** Per-channel lower clamp on the normalised shading. */
  readonly min: Float64Array = new Float64Array(3);
  /** Exposure gain of the last frame relative to the reference (per channel). */
  readonly gain: Float64Array = new Float64Array(3);

  constructor(public temporal = 0.5, public minFraction = 0.25) {}

  reset(): void {
    this.ref = null;
    this.shape = null;
  }

  /** Consumes one fit; returns false (and changes nothing) if it is unusable. */
  update(fit: ShFit): boolean {
    const br = fit.brightness;
    if (!(br[0] > 1e-4 && br[1] > 1e-4 && br[2] > 1e-4)) return false;
    if (!this.ref) this.ref = [br[0], br[1], br[2]];
    const shape = new Float64Array(27);
    for (let c = 0; c < 3; c++) for (let k = 0; k < SH_COUNT; k++) shape[c * SH_COUNT + k] = fit.coeffs[c * SH_COUNT + k] / br[c];
    if (this.shape) {
      const a = this.temporal;
      for (let i = 0; i < 27; i++) this.shape[i] = a * this.shape[i] + (1 - a) * shape[i];
    } else this.shape = shape;
    for (let c = 0; c < 3; c++) {
      const g = br[c] / this.ref[c];
      this.gain[c] = g;
      for (let k = 0; k < SH_COUNT; k++) this.coeffs[c * SH_COUNT + k] = this.shape[c * SH_COUNT + k] * g;
      this.min[c] = this.minFraction * g;
    }
    return true;
  }

  /** Normalised shading of channel c at a unit normal, clamped as in the shader. */
  shading(c: number, x: number, y: number, z: number): number {
    return Math.max(shEval(this.coeffs, c, x, y, z), this.min[c]);
  }
}

/** sRGB-encoded [0,1] -> linear. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Linear -> sRGB-encoded [0,1]. */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** 8-bit sRGB -> linear lookup table. */
export const SRGB_TO_LINEAR_8: Float32Array = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
