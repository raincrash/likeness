import { FaceDriver, defaultDriveOptions } from "../src/driver.js";
import { MEDIAPIPE_BLENDSHAPES } from "../src/mpConstants.js";
import { matToQuat } from "../src/frameBuilder.js";
import { canonicalFace, lowerLipDown, yaw, trackFrame, loadLiteModel, relativeRotation, rotationAngleDeg } from "./synthetic.js";

// FaceDriver on the lite landmark model, with synthetic faces built from MediaPipe's canonical mesh.

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${detail})`);
  if (!ok) failures++;
}

const lm = loadLiteModel();
const names = lm.expressionNames;
const face = canonicalFace();
const opt = { ...defaultDriveOptions };
let t = 0;
const step = (d: FaceDriver, points: Float32Array, n = 1) => { for (let i = 0; i < n; i++) d.update(trackFrame(points), opt, true, (t += 1 / 30)); };
const w = (d: FaceDriver, n: string) => d.weights[names.indexOf(n)];

// 1. Calibration on the neutral face, then lip parting.
const driver = new FaceDriver(lm, MEDIAPIPE_BLENDSHAPES);
step(driver, face, 44);
check("not calibrated after 44 frames", !driver.calibrated, `calibration ${driver.calibration.toFixed(2)}`);
step(driver, face, 1);
check("calibrated after 45 frames", driver.calibrated, `calibration ${driver.calibration.toFixed(2)}`);
step(driver, face, 10);
const restMax = Math.max(...Array.from(driver.weights));
check("neutral face stays neutral", restMax < 0.05, `max weight ${restMax.toFixed(3)}`);

step(driver, lowerLipDown(face, 4), 30);
const ldL = w(driver, "mouthLowerDown_L"), ldR = w(driver, "mouthLowerDown_R");
check("lips parted 4 mm -> mouthLowerDown > 0.4", ldL > 0.4 && ldR > 0.4,
  `L ${ldL.toFixed(3)}, R ${ldR.toFixed(3)}, jawOpen ${w(driver, "jawOpen").toFixed(3)}, lip gap ${driver.lipGapMm.toFixed(2)} mm`);
check("lip gap measured", driver.lipGapMm > 3, `lipGapMm ${driver.lipGapMm.toFixed(2)} (positive = opened)`);

step(driver, face, 30);
const back = Math.max(w(driver, "mouthLowerDown_L"), w(driver, "mouthLowerDown_R"));
check("lips close again", back < 0.05, `mouthLowerDown ${back.toFixed(3)}`);

// 2. Head yaw: a 25 degree turn is recovered (relative to the straight-on pose).
{
  step(driver, face, 1);
  const R0 = Float64Array.from(driver.headRotation!);
  step(driver, yaw(face, 25), 1);
  const R1 = Float64Array.from(driver.headRotation!);
  const rel = relativeRotation(R1, R0);
  const ang = rotationAngleDeg(rel);
  const q = matToQuat(rel);
  check("25 deg yaw recovered within 1 deg", Math.abs(ang - 25) < 1, `angle ${ang.toFixed(2)} deg`);
  check("yaw is about +y", q[1] > 0.2 && Math.abs(q[0]) < 0.02 && Math.abs(q[2]) < 0.02, `relative q = [${q.map((v) => v.toFixed(3)).join(", ")}]`);
}

// 3. Identity: fitIdentity returns coefficients and applies them to the landmark model.
{
  const before = Float32Array.from(lm.base);
  const coeffs = driver.fitIdentity();
  let moved = 0;
  for (let i = 0; i < before.length; i++) moved = Math.max(moved, Math.abs(lm.base[i] - before[i]));
  check("fitIdentity returns nI coefficients", !!coeffs && coeffs.length === lm.nI, `${coeffs?.length} coefficients`);
  check("fitIdentity applies them", !!coeffs && lm.identity.every((v, k) => v === coeffs[k]) && moved > 1e-4,
    `base moved up to ${(moved * 1000).toFixed(2)} mm`);
  driver.setIdentity(new Float32Array(lm.nI));
  check("setIdentity(0) restores the neutral", lm.base.every((v, i) => v === lm.neutral[i]), "base == neutral");
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
