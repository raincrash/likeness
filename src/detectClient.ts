// Main-thread side of detectWorker.ts: one worker per MediaPipe task, one request in flight.
import type { TrackFrame } from "./mpConstants.js";
import type { HandFrame } from "./handTracker.js";
import { bundledWorkerUrl } from "./assets.js";

export type DetectKind = "face" | "hands";

export type WorkerRequest =
  | { type: "init"; kind: DetectKind; wasmUrl?: string; modelUrl?: string }
  | { type: "detect"; id: number; ts: number; frame: VideoFrame | ImageBitmap }
  | { type: "close" };

export type WorkerReply =
  | { type: "ready" }
  | { type: "error"; id?: number; message: string }
  | { type: "face"; id: number; ms: number; face: TrackFrame | null }
  | { type: "hands"; id: number; ms: number; hands: HandFrame[] };

export type DetectReply = Extract<WorkerReply, { type: "face" | "hands" }>;

/** Whether this browser can run MediaPipe's GPU path in a worker and hand it video frames. */
export function workersSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    (typeof VideoFrame !== "undefined" || typeof createImageBitmap !== "undefined")
  );
}

/** Captures the video's current frame as a transferable image (a GPU-backed VideoFrame where available). */
export async function captureFrame(video: HTMLVideoElement, timestampMs: number): Promise<VideoFrame | ImageBitmap> {
  if (typeof VideoFrame !== "undefined") {
    try {
      return new VideoFrame(video, { timestamp: Math.round(timestampMs * 1000) });
    } catch {
      // Some browsers can't wrap every video source (e.g. no frame decoded yet): use a bitmap.
    }
  }
  return createImageBitmap(video);
}

/** Workers resolve relative URLs against their own script, so pass absolute ones. */
const absolute = (url?: string): string | undefined => (url === undefined ? undefined : new URL(url, location.href).href);

/** Longest a single detection may take before it's abandoned (the first one compiles GPU shaders). */
const DETECT_TIMEOUT_MS = 5000;

/** The worker script itself could not be loaded (as opposed to MediaPipe failing inside it). */
class WorkerLoadError extends Error {}

export class DetectWorker {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: DetectReply) => void; reject: (e: Error) => void }>();
  private closed = false;

  private constructor(private readonly worker: Worker, readonly kind: DetectKind) {
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      if (m.type === "ready" || m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === "error") p.reject(new Error(`likeness ${kind} worker: ${m.message}`));
      else p.resolve(m);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      this.failAll(new Error(`likeness ${kind} worker crashed: ${e.message}`));
    };
  }

  /**
   * Starts a worker and loads MediaPipe in it. Rejects if the worker can't run it (then use the main
   * thread). Tries `workerUrl` (default: the library build's assets/detect-worker.js), then the worker
   * your bundler built from the source, if the first one can't be loaded.
   */
  static async create(
    kind: DetectKind,
    opts: { wasmUrl?: string; modelUrl?: string; workerUrl?: string | URL; timeoutMs?: number } = {},
  ): Promise<DetectWorker> {
    const url = opts.workerUrl ?? bundledWorkerUrl();
    if (url) {
      try {
        return await DetectWorker.spawn(kind, () => new Worker(new URL(url, location.href), { type: "module" }), opts);
      } catch (err) {
        if (!(err instanceof WorkerLoadError)) throw err;
      }
    }
    return DetectWorker.spawn(kind, () => new Worker(new URL("./detectWorker.ts", import.meta.url), { type: "module" }), opts);
  }

  private static spawn(kind: DetectKind, make: () => Worker, opts: { wasmUrl?: string; modelUrl?: string; timeoutMs?: number }): Promise<DetectWorker> {
    let worker: Worker;
    try {
      worker = make();
    } catch (err) {
      return Promise.reject(new WorkerLoadError(String((err as Error)?.message ?? err)));
    }
    return new Promise((resolve, reject) => {
      let loaded = false;
      const fail = (err: Error) => {
        clearTimeout(timer);
        worker.terminate();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`likeness ${kind} worker: timed out loading MediaPipe`)), opts.timeoutMs ?? 60_000);
      worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        loaded = true;
        if (e.data.type === "ready") {
          clearTimeout(timer);
          resolve(new DetectWorker(worker, kind));
        } else if (e.data.type === "error") {
          fail(new Error(`likeness ${kind} worker: ${e.data.message}`));
        }
      };
      worker.onerror = (e) => {
        e.preventDefault();
        // An error before the worker says anything: its script didn't load (404, CSP, syntax).
        const msg = `likeness ${kind} worker: ${e.message || "failed to load"}`;
        fail(loaded ? new Error(msg) : new WorkerLoadError(msg));
      };
      const init: WorkerRequest = { type: "init", kind, wasmUrl: absolute(opts.wasmUrl), modelUrl: absolute(opts.modelUrl) };
      worker.postMessage(init);
    });
  }

  /** Detects on `frame` (transferred: the worker closes it). */
  detect(frame: VideoFrame | ImageBitmap, ts: number): Promise<DetectReply> {
    if (this.closed) {
      frame.close();
      return Promise.reject(new Error(`likeness ${this.kind} worker: closed`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A reply that never comes (a wedged GPU context) must not stall tracking for good: give up on
      // this frame after a while; the tracker reports the error and moves on to the next one.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`likeness ${this.kind} worker: no result after ${DETECT_TIMEOUT_MS} ms`));
      }, DETECT_TIMEOUT_MS);
      const done = <T>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      const req: WorkerRequest = { type: "detect", id, ts, frame };
      this.worker.postMessage(req, [frame]);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const req: WorkerRequest = { type: "close" };
    this.worker.postMessage(req);
    // Give MediaPipe a moment to release its GL context, then make sure the worker is gone.
    setTimeout(() => this.worker.terminate(), 1000);
    this.failAll(new Error(`likeness ${this.kind} worker: closed`));
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
