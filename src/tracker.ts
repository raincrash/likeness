import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { FACE_MODEL_URL, WASM_URL, sourceSize, type DetectSource, type TrackFrame } from "./mpConstants.js";

export { FACE_MODEL_URL, WASM_URL, RIGID_LANDMARKS, MEDIAPIPE_BLENDSHAPES } from "./mpConstants.js";
export type { TrackFrame } from "./mpConstants.js";

export interface MediaPipeOptions {
  /** Folder with MediaPipe's tasks-vision wasm files (default: jsDelivr, pinned version). */
  wasmUrl?: string;
  /** The .task model (default: Google's model storage). */
  modelUrl?: string;
  /** Load MediaPipe's ES-module wasm loader: needed in module workers, which have no importScripts. */
  esModule?: boolean;
}

export class FaceTracker {
  private constructor(private landmarker: FaceLandmarker) {}

  static async create(opts: MediaPipeOptions = {}): Promise<FaceTracker> {
    const fileset = await FilesetResolver.forVisionTasks(opts.wasmUrl ?? WASM_URL, opts.esModule);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opts.modelUrl ?? FACE_MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    return new FaceTracker(landmarker);
  }

  detect(src: DetectSource, timestampMs: number): TrackFrame | null {
    const res: FaceLandmarkerResult = this.landmarker.detectForVideo(src, timestampMs);
    const lm = res.faceLandmarks[0];
    if (!lm) return null;
    const [w, h] = sourceSize(src);
    const n = lm.length;
    const points = new Float32Array(n * 3);
    const normalized = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = lm[i];
      points[i * 3] = (p.x - 0.5) * w;
      points[i * 3 + 1] = -(p.y - 0.5) * h;
      points[i * 3 + 2] = -p.z * w;
      normalized[i * 2] = p.x;
      normalized[i * 2 + 1] = p.y;
    }
    const blendshapes: Record<string, number> = {};
    for (const c of res.faceBlendshapes[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;
    return { points, normalized, blendshapes };
  }

  close(): void {
    this.landmarker.close();
  }
}
