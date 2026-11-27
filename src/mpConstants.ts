// MediaPipe constants without importing MediaPipe, so modules that only need them (the driver, the
// worker client) don't pull @mediapipe/tasks-vision into the main bundle. tests/frame.test.ts checks
// the landmark sets against tasks-vision.

// Keep in sync with the installed @mediapipe/tasks-vision version.
export const MEDIAPIPE_VERSION = "1.2.3";
export const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
export const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** Stable upper-face MediaPipe landmarks (nose bridge, eye corners, forehead, temples). */
export const RIGID_LANDMARKS = [1, 4, 5, 6, 8, 9, 10, 151, 168, 195, 197, 33, 133, 362, 263, 70, 300, 105, 334, 234, 454];

/** Landmarks on FaceLandmarker.FACE_LANDMARKS_FACE_OVAL. */
export const FACE_OVAL_LANDMARKS = [
  10, 21, 54, 58, 67, 93, 103, 109, 127, 132, 136, 148, 149, 150, 152, 162, 172, 176, 234, 251, 284, 288, 297, 323,
  332, 338, 356, 361, 365, 377, 378, 379, 389, 397, 400, 454,
];

/** Landmarks on FaceLandmarker.FACE_LANDMARKS_LIPS. */
export const LIP_LANDMARKS = [
  0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91, 95, 146, 178, 181, 185, 191, 267, 269, 270, 291, 308,
  310, 311, 312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415,
];

/** MediaPipe's blendshape categories (ARKit names, plus "_neutral"). */
export const MEDIAPIPE_BLENDSHAPES = [
  "_neutral", "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "cheekPuff",
  "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
  "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight",
  "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft",
  "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight",
  "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft", "mouthSmileRight",
  "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight",
] as const;

export interface TrackFrame {
  /** 478 landmarks as xyz in pixel-like units: x right, y up, z towards camera. */
  points: Float32Array;
  /** Normalized image landmarks for drawing on the video: x, y pairs (x right, y down, 0..1). */
  normalized: Float32Array;
  blendshapes: Record<string, number>;
}

/** What MediaPipe's detectForVideo accepts and we pass it: a <video>, or a captured frame (workers). */
export type DetectSource = HTMLVideoElement | VideoFrame | ImageBitmap;

/** Pixel size of a detection source. */
export function sourceSize(src: DetectSource): [number, number] {
  if ("videoWidth" in src) return [src.videoWidth, src.videoHeight];
  if ("displayWidth" in src) return [src.displayWidth, src.displayHeight];
  return [src.width, src.height];
}
