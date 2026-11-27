// Small dense linear algebra for per-frame fitting. No dependencies, so it
// runs in the browser and in Node tests alike.

export type Mat3 = Float64Array; // row-major 3x3

export interface Similarity {
  s: number;
  R: Mat3;
  t: Float64Array;
}

/** Eigen-decomposition of a symmetric n x n matrix (Jacobi). Columns of V are eigenvectors. */
export function symmetricEigen(A: Float64Array, n: number): { values: Float64Array; V: Float64Array } {
  const a = Float64Array.from(A);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];
  return { values, V };
}

/**
 * Weighted similarity transform mapping src -> dst (Horn's quaternion method,
 * always a proper rotation). Points are packed xyz; only indices in `use` count.
 */
export function similarity(
  src: ArrayLike<number>,
  dst: ArrayLike<number>,
  w: ArrayLike<number>,
  use: ArrayLike<number>,
): Similarity {
  let W = 0;
  const ms = [0, 0, 0], md = [0, 0, 0];
  for (let k = 0; k < use.length; k++) {
    const i = use[k], wi = w[i];
    W += wi;
    for (let c = 0; c < 3; c++) {
      ms[c] += wi * src[i * 3 + c];
      md[c] += wi * dst[i * 3 + c];
    }
  }
  for (let c = 0; c < 3; c++) { ms[c] /= W; md[c] /= W; }

  const S = new Float64Array(9);
  let varS = 0;
  for (let k = 0; k < use.length; k++) {
    const i = use[k], wi = w[i];
    for (let r = 0; r < 3; r++) {
      const sr = src[i * 3 + r] - ms[r];
      varS += wi * sr * sr;
      for (let c = 0; c < 3; c++) S[r * 3 + c] += wi * sr * (dst[i * 3 + c] - md[c]);
    }
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = Float64Array.from([
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ]);
  const { values, V } = symmetricEigen(N, 4);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  const R = quatToMat(V[best], V[4 + best], V[8 + best], V[12 + best]);

  let num = 0;
  for (let k = 0; k < use.length; k++) {
    const i = use[k], wi = w[i];
    for (let r = 0; r < 3; r++) {
      let rs = 0;
      for (let c = 0; c < 3; c++) rs += R[r * 3 + c] * (src[i * 3 + c] - ms[c]);
      num += wi * rs * (dst[i * 3 + r] - md[r]);
    }
  }
  const s = num / varS;
  const t = new Float64Array(3);
  for (let r = 0; r < 3; r++) {
    let rm = 0;
    for (let c = 0; c < 3; c++) rm += R[r * 3 + c] * ms[c];
    t[r] = md[r] - s * rm;
  }
  return { s, R, t };
}

export function quatToMat(w: number, x: number, y: number, z: number): Mat3 {
  const n = Math.hypot(w, x, y, z);
  w /= n; x /= n; y /= n; z /= n;
  return Float64Array.from([
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ]);
}

/** Solve the SPD system A x = b in place via Cholesky. A is n x n row-major. */
export function choleskySolve(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(Math.max(sum, 1e-18)) : sum / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

export interface FitOptions {
  /** Ridge weight on coefficients, relative to the data term's scale. */
  regularization: number;
  /** Pull towards the prior coefficients passed to fit(). */
  temporal: number;
  /** Box constraints on the coefficients. */
  min: number;
  max: number;
  iterations: number;
}

export const defaultFitOptions: FitOptions = { regularization: 0.02, temporal: 0.05, min: -3, max: 3, iterations: 2 };

export interface FitResult {
  coeffs: Float32Array;
  /** Rotation taking the model frame to the observation (camera) frame. */
  rotation: Mat3;
  rmse: number;
}

/**
 * Fits linear blendshape coefficients e so that base + B e matches observed
 * landmarks up to an unknown similarity transform.
 *   base, observed: nL*3; basis: k rows of nL*3; weights: nL.
 * The rigid alignment uses only `rigidSet` (stable upper-face points) so
 * that expressions don't leak into head pose.
 */
export class LinearFitter {
  readonly k: number;
  readonly nL: number;
  private B: Float32Array;
  private BtWB: Float64Array;
  private scale: number;

  constructor(basis: Float32Array, k: number, private weights: Float32Array, private rigidSet: Uint32Array) {
    this.k = k;
    this.B = basis;
    this.nL = basis.length / k / 3;
    const n3 = this.nL * 3;
    this.BtWB = new Float64Array(k * k);
    for (let a = 0; a < k; a++) {
      for (let b = a; b < k; b++) {
        let sum = 0;
        for (let i = 0; i < n3; i++) sum += weights[(i / 3) | 0] * basis[a * n3 + i] * basis[b * n3 + i];
        this.BtWB[a * k + b] = sum;
        this.BtWB[b * k + a] = sum;
      }
    }
    let tr = 0;
    for (let a = 0; a < k; a++) tr += this.BtWB[a * k + a];
    this.scale = tr / k;
  }

  fit(base: Float32Array, observed: Float32Array, prev: Float32Array, opt: FitOptions = defaultFitOptions): FitResult {
    const { k, nL, B } = this;
    const n3 = nL * 3;
    const e = Float32Array.from(prev);
    const model = new Float32Array(n3);
    const aligned = new Float32Array(n3);
    let sim: Similarity = { s: 1, R: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float64Array(3) };

    const lam = opt.regularization * this.scale;
    const mu = opt.temporal * this.scale;
    const A = new Float64Array(k * k);
    for (let i = 0; i < k * k; i++) A[i] = this.BtWB[i];
    for (let a = 0; a < k; a++) A[a * k + a] += lam + mu;

    for (let it = 0; it < opt.iterations; it++) {
      for (let i = 0; i < n3; i++) {
        let v = base[i];
        for (let a = 0; a < k; a++) v += B[a * n3 + i] * e[a];
        model[i] = v;
      }
      sim = similarity(observed, model, this.weights, this.rigidSet);
      applySimilarity(sim, observed, aligned);

      const rhs = new Float64Array(k);
      for (let a = 0; a < k; a++) {
        let sum = 0;
        for (let i = 0; i < n3; i++) sum += this.weights[(i / 3) | 0] * B[a * n3 + i] * (aligned[i] - base[i]);
        rhs[a] = sum + mu * prev[a];
      }
      const x = choleskySolve(A, rhs, k);
      for (let a = 0; a < k; a++) e[a] = Math.max(opt.min, Math.min(opt.max, x[a]));
    }

    let err = 0, W = 0;
    for (let l = 0; l < nL; l++) {
      for (let c = 0; c < 3; c++) {
        const i = l * 3 + c;
        let v = base[i];
        for (let a = 0; a < k; a++) v += B[a * n3 + i] * e[a];
        err += this.weights[l] * (v - aligned[i]) ** 2;
      }
      W += this.weights[l];
    }
    return { coeffs: e, rotation: transpose(sim.R), rmse: Math.sqrt(err / W) };
  }
}

export function applySimilarity(sim: Similarity, src: ArrayLike<number>, out: Float32Array): void {
  const { s, R, t } = sim;
  for (let i = 0; i < out.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[i] = s * (R[0] * x + R[1] * y + R[2] * z) + t[0];
    out[i + 1] = s * (R[3] * x + R[4] * y + R[5] * z) + t[1];
    out[i + 2] = s * (R[6] * x + R[7] * y + R[8] * z) + t[2];
  }
}

export function transpose(R: Mat3): Mat3 {
  return Float64Array.from([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
}

/**
 * Box-constrained ridge regression with a prior:
 *   min ||W^(1/2)(B w - y)||^2 + sum_a D_a (lam w_a^2 + mu (w_a - prior_a)^2),  lo <= w <= hi
 * where D_a = (B^T W B)_aa. Scaling the penalties per coefficient (Jacobi)
 * makes lam/mu mean the same thing for a shape that moves the lips 3 mm as
 * for one that moves the jaw 35 mm; a single global scale lets the big shapes
 * set the penalty and silently crushes the small ones.
 * B is k rows of n. Bounds are enforced by fixing violated coefficients at the
 * bound and re-solving the rest (a few active-set passes).
 */
export class BoundedRidge {
  private BtWB: Float64Array;
  readonly scale: number;

  constructor(private B: Float32Array, readonly k: number, private W: Float32Array) {
    const n = B.length / k;
    this.BtWB = new Float64Array(k * k);
    for (let a = 0; a < k; a++) {
      for (let b = a; b < k; b++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += W[i] * B[a * n + i] * B[b * n + i];
        this.BtWB[a * k + b] = this.BtWB[b * k + a] = s;
      }
    }
    let tr = 0;
    for (let a = 0; a < k; a++) tr += this.BtWB[a * k + a];
    this.scale = tr / k || 1;
  }

  /** `lamScale` optionally multiplies the ridge weight per coefficient. */
  solve(y: Float32Array, prior: Float32Array, lamRel: number, muRel: number, lo = 0, hi = 1, lamScale?: Float32Array): Float32Array {
    const { k, B, W } = this;
    const n = B.length / k;
    const D = new Float64Array(k);
    for (let a = 0; a < k; a++) D[a] = Math.max(this.BtWB[a * k + a], 1e-3 * this.scale);
    const Bty = new Float64Array(k);
    for (let a = 0; a < k; a++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += W[i] * B[a * n + i] * y[i];
      Bty[a] = s + muRel * D[a] * prior[a];
    }
    const w = new Float32Array(k);
    const fixed = new Int8Array(k); // 0 free, -1 at lo, +1 at hi
    for (let pass = 0; pass < 4; pass++) {
      const free: number[] = [];
      for (let a = 0; a < k; a++) if (!fixed[a]) free.push(a);
      const m = free.length;
      const A = new Float64Array(m * m), rhs = new Float64Array(m);
      free.forEach((a, i) => {
        let r = Bty[a];
        for (let b = 0; b < k; b++) if (fixed[b]) r -= this.BtWB[a * k + b] * (fixed[b] > 0 ? hi : lo);
        rhs[i] = r;
        free.forEach((b, j) => (A[i * m + j] = this.BtWB[a * k + b] + (i === j ? D[a] * (lamRel * (lamScale ? lamScale[a] : 1) + muRel) : 0)));
      });
      const x = m ? choleskySolve(A, rhs, m) : new Float64Array(0);
      let changed = false;
      free.forEach((a, i) => {
        if (x[i] < lo) { fixed[a] = -1; changed = true; }
        else if (x[i] > hi) { fixed[a] = 1; changed = true; }
        w[a] = Math.max(lo, Math.min(hi, x[i]));
      });
      for (let a = 0; a < k; a++) if (fixed[a]) w[a] = fixed[a] > 0 ? hi : lo;
      if (!changed) break;
    }
    return w;
  }
}

/** One Euro filter (Casiez et al. 2012): low lag on fast motion, smooth when still. */
export class OneEuro {
  private x: Float32Array;
  private dx: Float32Array;
  private t = -1;

  constructor(n: number, public minCutoff: Float32Array, public beta = 1.5, public dCutoff = 1) {
    this.x = new Float32Array(n);
    this.dx = new Float32Array(n);
  }

  filter(value: Float32Array, tSec: number, out: Float32Array): void {
    if (this.t < 0 || tSec <= this.t) {
      this.x.set(value);
      this.dx.fill(0);
      this.t = tSec;
      out.set(value);
      return;
    }
    const dt = Math.min(tSec - this.t, 0.25);
    this.t = tSec;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const ad = alpha(this.dCutoff);
    for (let i = 0; i < value.length; i++) {
      const d = (value[i] - this.x[i]) / dt;
      this.dx[i] += ad * (d - this.dx[i]);
      const a = alpha(this.minCutoff[i] + this.beta * Math.abs(this.dx[i]));
      this.x[i] += a * (value[i] - this.x[i]);
      out[i] = this.x[i];
    }
  }

  reset(): void { this.t = -1; }
}
