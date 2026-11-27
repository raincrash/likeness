// Web Worker that runs one MediaPipe landmarker (face or hands) off the main thread.
// LikenessTracker starts one per task, so face and hand detection run in parallel.
// Protocol: see detectClient.ts.
import { FaceTracker } from "./tracker.js";
import { HandTracker } from "./handTracker.js";
import type { WorkerRequest, WorkerReply } from "./detectClient.js";

type Detector = FaceTracker | HandTracker;

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerReply, transfer?: Transferable[]): void;
  close(): void;
};

let detector: Detector | null = null;

scope.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      const opts = { wasmUrl: m.wasmUrl, modelUrl: m.modelUrl, esModule: true };
      detector = m.kind === "face" ? await FaceTracker.create(opts) : await HandTracker.create(opts);
      scope.postMessage({ type: "ready" });
    } catch (err) {
      scope.postMessage({ type: "error", message: String((err as Error)?.message ?? err) });
    }
    return;
  }
  if (m.type === "detect") {
    const frame = m.frame;
    try {
      if (!detector) throw new Error("likeness detect worker: not initialised");
      const t0 = performance.now();
      if (detector instanceof FaceTracker) {
        const face = detector.detect(frame, m.ts);
        const ms = performance.now() - t0;
        scope.postMessage({ type: "face", id: m.id, ms, face }, face ? [face.points.buffer, face.normalized.buffer] : []);
      } else {
        const hands = detector.detect(frame, m.ts);
        const ms = performance.now() - t0;
        scope.postMessage({ type: "hands", id: m.id, ms, hands }, hands.flatMap((h) => [h.image.buffer, h.world.buffer]));
      }
    } catch (err) {
      scope.postMessage({ type: "error", id: m.id, message: String((err as Error)?.message ?? err) });
    } finally {
      frame.close();
    }
    return;
  }
  if (m.type === "close") {
    detector?.close();
    detector = null;
    scope.close();
  }
};
