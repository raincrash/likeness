import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { subjectHandedness, type Handedness } from "./handMath.js";
import { HAND_MODEL_URL, WASM_URL, type DetectSource } from "./mpConstants.js";
import type { MediaPipeOptions } from "./tracker.js";

export { HAND_MODEL_URL };

export type { Handedness };
/** HandFrame -> the public LikenessFrame hand (src/frame.ts), and the focal length from a horizontal FOV. */
export { toHandOutput, focalFromFov } from "./handMath.js";

export interface HandFrame {
  /** The subject's own hand (not the viewer's): our video frames are not mirrored. */
  handedness: Handedness;
  /** Handedness classifier score, 0..1. */
  score: number;
  /** 21*3 normalized image landmarks: x right, y down (0..1), z relative depth (smaller = closer). */
  image: Float32Array;
  /** 21*3 world landmarks in metres around the hand's centre, camera axes: x right, y down, z away. */
  world: Float32Array;
}

export class HandTracker {
  private constructor(private landmarker: HandLandmarker) {}

  static async create(opts: MediaPipeOptions = {}): Promise<HandTracker> {
    const fileset = await FilesetResolver.forVisionTasks(opts.wasmUrl ?? WASM_URL, opts.esModule);
    const landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opts.modelUrl ?? HAND_MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    return new HandTracker(landmarker);
  }

  /** Detects up to two hands. Call with the same video frame and timestamp as the face tracker. */
  detect(src: DetectSource, timestampMs: number): HandFrame[] {
    const res: HandLandmarkerResult = this.landmarker.detectForVideo(src, timestampMs);
    const hands: HandFrame[] = [];
    res.landmarks.forEach((lm, h) => {
      const wl = res.worldLandmarks[h];
      const cat = res.handedness[h]?.[0];
      const handedness = cat ? subjectHandedness(cat.categoryName) : null;
      if (!wl || !handedness || lm.length !== 21) return;
      const image = new Float32Array(63), world = new Float32Array(63);
      for (let i = 0; i < 21; i++) {
        image[i * 3] = lm[i].x; image[i * 3 + 1] = lm[i].y; image[i * 3 + 2] = lm[i].z;
        world[i * 3] = wl[i].x; world[i * 3 + 1] = wl[i].y; world[i * 3 + 2] = wl[i].z;
      }
      hands.push({ handedness, score: cat.score, image, world });
    });
    // Two hands with the same label: the classifier got one wrong, most likely the less confident one.
    if (hands.length === 2 && hands[0].handedness === hands[1].handedness) {
      const weaker = hands[0].score < hands[1].score ? hands[0] : hands[1];
      weaker.handedness = weaker.handedness === "Left" ? "Right" : "Left";
      weaker.score = 1 - weaker.score;
    }
    return hands;
  }

  close(): void {
    this.landmarker.close();
  }
}
