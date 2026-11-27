import { FaceDriver, defaultDriveOptions } from "../src/driver.js";
import { FaceLandmarker } from "@mediapipe/tasks-vision";
import { MEDIAPIPE_BLENDSHAPES, FACE_OVAL_LANDMARKS, LIP_LANDMARKS, MEDIAPIPE_VERSION } from "../src/mpConstants.js";
import { readFileSync } from "node:fs";
import { ARKIT_BLENDSHAPES, ictArkitName, ictToArkit, type LikenessFrame } from "../src/frame.js";
import { buildFaceOutput, buildFrame, headPose, matToQuat } from "../src/frameBuilder.js";
import { focalFromFov } from "../src/handMath.js";
import { quatToMat } from "../src/solver.js";
import { canonicalFace, yaw, trackFrame, loadLiteModel } from "./synthetic.js";

// LikenessFrame assembly: quaternion and position conventions, JSON round trip.

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${detail})`);
  if (!ok) failures++;
}
const fmt = (a: ArrayLike<number>) => `[${Array.from(a, (v) => v.toFixed(4)).join(", ")}]`;
const rotY = (deg: number) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return Float64Array.from([c, 0, s, 0, 1, 0, -s, 0, c]);
};

// 1. matToQuat round trip on a random rotation, w >= 0.
{
  const q0 = [0.3, -0.5, 0.2, -0.78];
  const n = Math.hypot(...q0);
  const R = quatToMat(q0[3] / n, q0[0] / n, q0[1] / n, q0[2] / n);
  const q = matToQuat(R);
  const R2 = quatToMat(q[3], q[0], q[1], q[2]);
  const err = Math.max(...Array.from(R, (v, i) => Math.abs(v - R2[i])));
  check("matToQuat round trip", err < 1e-12 && q[3] >= 0, `max R err ${err.toExponential(1)}, w ${q[3].toFixed(3)}`);
}

// 2. headPose of a known similarity: the head turned 30 deg about +y (towards camera +x, the
//    subject's left) has quaternion [0, sin 15, 0, cos 15]; position from the image offset and scale.
{
  const W = 1280, f = focalFromFov(W, 65), s = 0.0004; // 0.4 mm per pixel -> depth f*s
  const R = rotY(-30); // the similarity maps camera -> model, so it holds the inverse rotation
  const obs0 = [100, 50, 0]; // where the model origin is, in centred camera pixels (x right, y up)
  const t = Float64Array.from([0, 1, 2], (i) => -s * (R[i * 3] * obs0[0] + R[i * 3 + 1] * obs0[1] + R[i * 3 + 2] * obs0[2]));
  const pose = headPose({ s, R, t }, f);
  const want = [0, Math.sin((15 * Math.PI) / 180), 0, Math.cos((15 * Math.PI) / 180)];
  const qErr = Math.max(...pose.rotation.map((v, i) => Math.abs(v - want[i])));
  check("yaw +30 deg -> q = [0, +sin15, 0, cos15]", qErr < 1e-9, `q ${fmt(pose.rotation)}`);
  const pWant = [100 * s, 50 * s, -f * s];
  const pErr = Math.max(...pose.position.map((v, i) => Math.abs(v - pWant[i])));
  check("head position", pErr < 1e-12, `position ${fmt(pose.position)} m, depth ${(f * s).toFixed(3)} m`);
}

// 3. End to end through the driver: a face turned to the subject's left gives q.y > 0.
const lm = loadLiteModel();
const driver = new FaceDriver(lm, MEDIAPIPE_BLENDSHAPES);
const face = canonicalFace();
let tSec = 0;
for (let i = 0; i < 50; i++) driver.update(trackFrame(face, { jawOpen: 0.02 }), defaultDriveOptions, true, (tSec += 1 / 30));
const f = focalFromFov(1280, 65);
for (const deg of [20, -20]) {
  driver.update(trackFrame(yaw(face, deg)), defaultDriveOptions, true, (tSec += 1 / 30));
  const pose = headPose(driver.lastSim!, f);
  const ang = (2 * Math.asin(Math.min(1, Math.abs(pose.rotation[1]))) * 180) / Math.PI;
  check(`driver yaw ${deg} deg -> sign(q.y)`, Math.sign(pose.rotation[1]) === Math.sign(deg) && Math.abs(ang - Math.abs(deg)) < 1.5,
    `q ${fmt(pose.rotation)} (~${ang.toFixed(1)} deg about y)`);
}

// 4. A complete frame survives JSON.
{
  driver.update(trackFrame(face, { jawOpen: 0.6, mouthSmileLeft: 0.4, browInnerUp: 0.5 }), defaultDriveOptions, true, (tSec += 1 / 30));
  const faceOut = buildFaceOutput(lm.expressionNames, driver.weights, driver.lastSim!, f, driver.calibrated);
  const hands = [{ side: "left" as const, score: 0.9, joints: Array.from({ length: 21 }, (_, i) => [i * 0.01, -0.1, -0.5] as [number, number, number]) }];
  const frame: LikenessFrame = buildFrame(1234.5, faceOut, hands);
  const back = JSON.parse(JSON.stringify(frame)) as LikenessFrame;
  const keys = Object.keys(back.face!.blendshapes);
  check("JSON round trip", JSON.stringify(back) === JSON.stringify(frame) && back.v === 1 && back.t === 1234.5, `${JSON.stringify(frame).length} bytes`);
  check("52 ARKit blendshapes in [0, 1]", keys.length === 52 && ARKIT_BLENDSHAPES.every((k) => {
    const v = back.face!.blendshapes[k];
    return Number.isFinite(v) && v >= 0 && v <= 1;
  }), `jawOpen ${back.face!.blendshapes.jawOpen.toFixed(3)}, mouthSmileLeft ${back.face!.blendshapes.mouthSmileLeft.toFixed(3)}`);
  check("calibrated flag", back.face!.calibrated === true, `${back.face!.calibrated}`);
  check("head in front of the camera", back.face!.head.position[2] < 0, `z ${back.face!.head.position[2].toFixed(3)} m`);
  check("hands carried", back.hands.length === 1 && back.hands[0].joints.length === 21, `${back.hands.length} hand`);
}

// 5. ICT <-> ARKit names: frame.ts (ictToArkit), the driver's MediaPipe sources and the avatar's
//    inverse mapping (ictArkitName) must agree, including the split browInnerUp / cheekPuff halves.
{
  const names = lm.expressionNames;
  const at = (n: string) => names.indexOf(n);
  const w = Float32Array.from(names, (_, e) => (e + 1) / 100);
  const out = ictToArkit(names, w);
  const again = ictToArkit(names, w); // cached plan
  const want = (a: string) => {
    if (a === "tongueOut") return 0;
    if (a === "browInnerUp" || a === "cheekPuff") return (w[at(`${a}_L`)] + w[at(`${a}_R`)]) / 2;
    const ict = a.replace(/Left$/, "_L").replace(/Right$/, "_R");
    return w[at(at(ict) >= 0 ? ict : a)];
  };
  const bad = ARKIT_BLENDSHAPES.filter((a) => Math.abs(out[a] - want(a)) > 1e-6 || out[a] !== again[a]);
  check("ictToArkit maps every ARKit name (split halves averaged, tongueOut 0)", bad.length === 0 && Object.keys(out).length === 52,
    bad.length ? `wrong: ${bad.join(", ")}` : `browInnerUp ${out.browInnerUp.toFixed(3)}, cheekPuff ${out.cheekPuff.toFixed(3)}`);
  const missing = ARKIT_BLENDSHAPES.filter((a) => a !== "tongueOut" && !names.some((n) => ictArkitName(n) === a));
  check("every ARKit name but tongueOut has an ICT source", missing.length === 0, missing.join(", ") || "ok");
  const unmapped = names.filter((n) => !ictArkitName(n));
  check("only ICT-only shapes are unmapped", unmapped.every((n) => /^(PupilDilate|cheekRaiser)_[LR]$/.test(n)), unmapped.join(", "));
  const mismatched = names.filter((n, e) => (driver.sources[e] ?? null) !== ictArkitName(n));
  check("driver MediaPipe source == ARKit name of each ICT shape", mismatched.length === 0, mismatched.join(", ") || `${names.length} shapes`);
}

// mpConstants.ts copies a few MediaPipe constants so the main bundle needn't import MediaPipe.
{
  const set = (c: { start: number; end: number }[]) => [...new Set(c.flatMap((x) => [x.start, x.end]))].sort((a, b) => a - b).join();
  const version = (JSON.parse(readFileSync("node_modules/@mediapipe/tasks-vision/package.json", "utf8")) as { version: string }).version;
  check("mpConstants match the installed tasks-vision",
    set(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL) === FACE_OVAL_LANDMARKS.join() && set(FaceLandmarker.FACE_LANDMARKS_LIPS) === LIP_LANDMARKS.join() && version === MEDIAPIPE_VERSION,
    `tasks-vision ${version}`);
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
