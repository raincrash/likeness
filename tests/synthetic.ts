import { readFileSync } from "fs";
import { LandmarkModel, type LandmarkModelMeta } from "../src/landmarkModel.js";
import type { TrackFrame } from "../src/mpConstants.js";

/** Shared helpers for the driver/frame tests: synthetic MediaPipe frames from the canonical face. */

export const PX_PER_CM = 30;

/** MediaPipe's canonical face (cm, x right, y up, z towards the camera) as 468*3 "pixels". */
export function canonicalFace(): Float32Array {
  const v = readFileSync("assets/canonical_face_model.obj", "utf8").split("\n")
    .filter((l) => l.startsWith("v ")).flatMap((l) => l.split(/\s+/).slice(1, 4).map(Number));
  return Float32Array.from(v, (x) => x * PX_PER_CM);
}

/** Lower lip, outer and inner contours, without the mouth corners. */
export const LOWER_LIP = [146, 91, 181, 84, 17, 314, 405, 321, 375, 95, 88, 178, 87, 14, 317, 402, 318, 324];

export function lowerLipDown(points: Float32Array, mm: number): Float32Array {
  const out = Float32Array.from(points);
  for (const i of LOWER_LIP) out[i * 3 + 1] -= (mm / 10) * PX_PER_CM;
  return out;
}

/** Rotates about the y axis (camera up) through the face centroid: +deg turns the nose towards +x. */
export function yaw(points: Float32Array, deg: number): Float32Array {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), n = points.length / 3;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += points[i * 3] / n; cz += points[i * 3 + 2] / n; }
  const out = Float32Array.from(points);
  for (let i = 0; i < n; i++) {
    const x = points[i * 3] - cx, z = points[i * 3 + 2] - cz;
    out[i * 3] = cx + c * x + s * z;
    out[i * 3 + 2] = cz - s * x + c * z;
  }
  return out;
}

export function trackFrame(points: Float32Array, blendshapes: Record<string, number> = {}): TrackFrame {
  return { points, normalized: new Float32Array(0), blendshapes };
}

export function loadLiteModel(): LandmarkModel {
  const b = readFileSync("public/ict/ict-landmarks.bin");
  return LandmarkModel.parse(
    JSON.parse(readFileSync("public/ict/ict-landmarks.json", "utf8")) as LandmarkModelMeta,
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
  );
}

/** Rotation angle (degrees) and the y component's sign of A * Bᵀ (row-major 3x3). */
export function relativeRotation(A: ArrayLike<number>, B: ArrayLike<number>): number[] {
  const R: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let v = 0;
    for (let k = 0; k < 3; k++) v += A[i * 3 + k] * B[j * 3 + k];
    R.push(v);
  }
  return R;
}

export const rotationAngleDeg = (R: ArrayLike<number>) =>
  (Math.acos(Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2))) * 180) / Math.PI;
