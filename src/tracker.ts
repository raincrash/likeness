import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";

// Keep in sync with the installed @mediapipe/tasks-vision version.
export const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
export const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Stable upper-face MediaPipe landmarks (nose bridge, eye corners, forehead, temples). */
export const RIGID_LANDMARKS = [1, 4, 5, 6, 8, 9, 10, 151, 168, 195, 197, 33, 133, 362, 263, 70, 300, 105, 334, 234, 454];

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
  /** Raw normalized landmarks for drawing on the video. */
  normalized: { x: number; y: number }[];
  blendshapes: Record<string, number>;
}

export class FaceTracker {
  private constructor(private landmarker: FaceLandmarker) {}

  /**
   * @param opts.wasmUrl folder with MediaPipe's tasks-vision wasm files (default: jsDelivr, pinned version).
   * @param opts.modelUrl face_landmarker.task (default: Google's model storage).
   */
  static async create(opts: { wasmUrl?: string; modelUrl?: string } = {}): Promise<FaceTracker> {
    const fileset = await FilesetResolver.forVisionTasks(opts.wasmUrl ?? WASM_URL);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opts.modelUrl ?? FACE_MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    return new FaceTracker(landmarker);
  }

  detect(video: HTMLVideoElement, timestampMs: number): TrackFrame | null {
    const res: FaceLandmarkerResult = this.landmarker.detectForVideo(video, timestampMs);
    const lm = res.faceLandmarks[0];
    if (!lm) return null;
    const w = video.videoWidth, h = video.videoHeight;
    const points = new Float32Array(lm.length * 3);
    lm.forEach((p, i) => {
      points[i * 3] = (p.x - 0.5) * w;
      points[i * 3 + 1] = -(p.y - 0.5) * h;
      points[i * 3 + 2] = -p.z * w;
    });
    const blendshapes: Record<string, number> = {};
    for (const c of res.faceBlendshapes[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;
    return { points, normalized: lm, blendshapes };
  }

  close(): void {
    this.landmarker.close();
  }
}

export { FaceLandmarker };
