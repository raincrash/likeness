import { ictToArkit, type FaceOutput, type HandOutput, type LikenessFrame } from "./frame.js";
import type { Similarity } from "./solver.js";

// Pure LikenessFrame assembly (no DOM, no MediaPipe), shared by LikenessTracker and the Node tests.

/** Horizontal field of view assumed for an uncalibrated webcam, degrees. */
export const DEFAULT_HFOV_DEG = 65;

/**
 * Unit quaternion [x, y, z, w] of a row-major rotation matrix, with w >= 0.
 * (Shepperd's method, numerically stable for all rotations.)
 */
export function matToQuat(R: ArrayLike<number>): [number, number, number, number] {
  const m00 = R[0], m01 = R[1], m02 = R[2], m10 = R[3], m11 = R[4], m12 = R[5], m20 = R[6], m21 = R[7], m22 = R[8];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  const sign = w < 0 ? -1 : 1;
  return [(sign * x) / n, (sign * y) / n, (sign * z) / n, (sign * w) / n];
}

/**
 * Head pose in the LikenessFrame camera frame (see frame.ts) from the driver's similarity
 * (driver.lastSim: camera pixels, centred, x right, y up, z towards the camera -> model metres).
 *
 * - rotation: the head's orientation, i.e. the driver's headRotation (= Rᵀ, model -> camera) as a
 *   quaternion; identity = facing the camera.
 * - position: the head model's origin (roughly the centre of the head, ~6 cm behind the face
 *   surface) in metres. The similarity's scale s is metres per pixel at the face, so the depth
 *   is focal * s (pinhole camera); x and y are the origin's image position (pixels from the
 *   image centre) times s. z is negative (in front of the camera). Approximate: it assumes the
 *   focal length, i.e. the camera's field of view.
 */
export function headPose(sim: Similarity, focalPx: number): FaceOutput["head"] {
  const { s, R, t } = sim;
  // Model origin in camera pixels: obs = Rᵀ (0 - t) / s, so its metric offset is -Rᵀ t.
  const x = -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]);
  const y = -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]);
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  return { rotation: matToQuat(Rt), position: [x, y, -focalPx * s] };
}

/** The face part of a LikenessFrame from the driver's state. */
export function buildFaceOutput(
  ictNames: readonly string[],
  ictWeights: ArrayLike<number>,
  sim: Similarity,
  focalPx: number,
  calibrated: boolean,
): FaceOutput {
  return { blendshapes: ictToArkit(ictNames, ictWeights), head: headPose(sim, focalPx), calibrated };
}

/** Assembles a LikenessFrame (format v1). */
export function buildFrame(t: number, face: FaceOutput | null, hands: HandOutput[]): LikenessFrame {
  return { v: 1, t, face, hands };
}
