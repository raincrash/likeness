import { readFileSync } from "fs";
import { IctModel, LandmarkSampler, type IctMeta } from "../src/ict.js";
import { LandmarkModel, type LandmarkModelMeta } from "../src/landmarkModel.js";

// The lite landmark file must carry the same data as the full ICT model sampled at its landmarks.

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${detail})`);
  if (!ok) failures++;
}
const buffer = (path: string) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = a.length === b.length ? 0 : Infinity;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const maxAbs = (a: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; };

const full = new IctModel(JSON.parse(readFileSync("public/ict/ict.json", "utf8")) as IctMeta, buffer("public/ict/ict.bin"));
const lite = LandmarkModel.parse(JSON.parse(readFileSync("public/ict/ict-landmarks.json", "utf8")) as LandmarkModelMeta, buffer("public/ict/ict-landmarks.bin"));
const ref = LandmarkModel.fromIct(full);

check("expression names", JSON.stringify(lite.expressionNames) === JSON.stringify(ref.expressionNames), `${lite.nE} expressions`);
check("mediapipe indices", maxDiff(lite.mpIndex, ref.mpIndex) === 0, `${lite.count} landmarks`);
check("identity count", lite.nI === full.nI, `${lite.nI} identities`);
// Tolerance: 1e-7 m = 0.1 µm (float32 rounding of the same sums).
for (const [name, a, b] of [
  ["neutral", lite.neutral, ref.neutral],
  ["expression basis", lite.expressionBasis, ref.expressionBasis],
  ["identity basis", lite.identityBasis, ref.identityBasis],
] as const) {
  const d = maxDiff(a, b);
  check(name, d < 1e-7, `max |diff| ${d.toExponential(1)} m, max |value| ${maxAbs(b).toFixed(4)} m`);
}

// setIdentity on the landmark model == sampling the full model's identity mesh.
{
  const coeffs = Float32Array.from({ length: full.nI }, (_, k) => Math.sin(k * 1.7) * 1.5);
  full.setIdentity(coeffs);
  lite.setIdentity(coeffs);
  const sampler = new LandmarkSampler(full);
  const sampled = new Float32Array(sampler.count * 3);
  sampler.sample(full.base, sampled);
  const d = maxDiff(lite.base, sampled);
  check("identity base", d < 1e-6, `max |diff| ${d.toExponential(1)} m`);
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
