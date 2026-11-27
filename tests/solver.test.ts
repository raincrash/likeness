import { LinearFitter, similarity, quatToMat, applySimilarity, defaultFitOptions } from "../src/solver.js";

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${detail})`);
  if (!ok) failures++;
}

// 1. Similarity recovers a known transform.
{
  const n = 30;
  const src = Float32Array.from({ length: n * 3 }, rand);
  const truth = { s: 2.5, R: quatToMat(0.9, 0.2, -0.3, 0.1), t: Float64Array.from([1, -2, 0.5]) };
  const dst = new Float32Array(n * 3);
  applySimilarity(truth, src, dst);
  const est = similarity(src, dst, new Float32Array(n).fill(1), Uint32Array.from({ length: n }, (_, i) => i));
  const rErr = Math.max(...est.R.map((v, i) => Math.abs(v - truth.R[i])));
  check("similarity", Math.abs(est.s - 2.5) < 1e-6 && rErr < 1e-6, `scale ${est.s.toFixed(6)}, max R err ${rErr.toExponential(1)}`);
}

// 2. Fitter recovers blendshape coefficients through an unknown similarity.
{
  const nL = 120, k = 20;
  const base = Float32Array.from({ length: nL * 3 }, () => rand() * 0.08);
  const basis = Float32Array.from({ length: k * nL * 3 }, () => rand() * 0.002);
  const eTrue = Float32Array.from({ length: k }, () => rand() * 1.5);
  const model = Float32Array.from(base);
  for (let a = 0; a < k; a++) for (let i = 0; i < nL * 3; i++) model[i] += basis[a * nL * 3 + i] * eTrue[a];
  // Observation = model seen through rotation R, scale 900 (pixels), offset.
  const R = quatToMat(0.95, 0.1, 0.25, -0.05);
  const obs = new Float32Array(nL * 3);
  applySimilarity({ s: 900, R, t: Float64Array.from([320, 240, 10]) }, model, obs);
  // Rigid set = first 30 landmarks, which we keep expression-free.
  for (let a = 0; a < k; a++) for (let i = 0; i < 90; i++) basis[a * nL * 3 + i] = 0;
  model.set(base.subarray(0, 90), 0);
  applySimilarity({ s: 900, R, t: Float64Array.from([320, 240, 10]) }, model, obs);

  const fitter = new LinearFitter(basis, k, new Float32Array(nL).fill(1), Uint32Array.from({ length: 30 }, (_, i) => i));
  const res = fitter.fit(base, obs, new Float32Array(k), { ...defaultFitOptions, regularization: 1e-6, temporal: 0, iterations: 3 });
  const eErr = Math.max(...res.coeffs.map((v, i) => Math.abs(v - eTrue[i])));
  const rErr = Math.max(...res.rotation.map((v, i) => Math.abs(v - R[i])));
  check("fitter coefficients", eErr < 0.01, `max coeff err ${eErr.toExponential(1)}`);
  check("fitter head rotation", rErr < 1e-4, `max R err ${rErr.toExponential(1)}`);
  check("fitter rmse", res.rmse < 1e-4, `rmse ${res.rmse.toExponential(1)}`);

  const t0 = performance.now();
  const fitter50 = new LinearFitter(new Float32Array(50 * 468 * 3).map(() => rand() * 0.002), 50, new Float32Array(468).fill(1), Uint32Array.from({ length: 30 }, (_, i) => i));
  const b = new Float32Array(468 * 3).map(() => rand());
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) fitter50.fit(b, b, new Float32Array(50));
  console.log(`     perf: setup ${(t1 - t0).toFixed(0)} ms, fit ${((performance.now() - t1) / 20).toFixed(2)} ms/frame (468 lmk, 50 comps)`);
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
