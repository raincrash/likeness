import { FaceTracker, MEDIAPIPE_BLENDSHAPES } from "./tracker.js";
import { HandTracker, focalFromFov } from "./handTracker.js";
import { HandFilterBank } from "./handFilter.js";
import { SpeechMeter } from "./audio.js";
import { Perf } from "./perf.js";
import { FaceDriver, defaultDriveOptions, type DriveOptions } from "./driver.js";
import { LandmarkModel } from "./landmarkModel.js";
import { buildFaceOutput, buildFrame, DEFAULT_HFOV_DEG } from "./frameBuilder.js";
import { assetUrl } from "./assets.js";
import type { HandOutput, LikenessFrame } from "./frame.js";
import type { Similarity } from "./solver.js";

export interface LikenessTrackerOptions {
  /** Track hands too (loads MediaPipe's hand landmarker). Default false; see setHands(). */
  hands?: boolean;
  /** Lip-sync landmark fit (DriveOptions.lipSync). Default true. */
  lipSync?: boolean;
  /** Folder containing ict-landmarks.json and ict-landmarks.bin. Default: assetUrl("ict"). */
  modelUrl?: string;
  /** Folder with MediaPipe tasks-vision's wasm files. Default: jsDelivr, the pinned version. */
  wasmUrl?: string;
  /** MediaPipe face_landmarker.task URL. Default: Google's model storage. */
  faceModelUrl?: string;
  /** MediaPipe hand_landmarker.task URL. Default: Google's model storage. */
  handModelUrl?: string;
  /** Assumed horizontal field of view of the camera in degrees, used for head and hand positions. Default 65. */
  hfov?: number;
  /** Initial driver options (merged over the defaults); tune live through `tracker.options`. */
  options?: Partial<DriveOptions>;
}

/** What start() accepts: a playing/playable video element, a MediaStream, or camera constraints. */
export type TrackerSource = HTMLVideoElement | MediaStream | { camera?: MediaTrackConstraints };

export interface LikenessTrackerEvents {
  /** One per processed video frame (also from process()); `face` is null when no face was found. */
  frame: (frame: LikenessFrame) => void;
  /** Neutral-face calibration finished (after start(), calibrate(), or the first ~45 face frames). */
  calibrated: () => void;
  /** A failure in the tracking loop or in start(); the loop keeps running. */
  error: (error: Error) => void;
  /** Tracking started on this video. */
  start: (video: HTMLVideoElement) => void;
  stop: () => void;
}

/** Default webcam: 1280x720, user-facing. */
export const DEFAULT_CAMERA: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };

type Listeners = { [K in keyof LikenessTrackerEvents]: Set<LikenessTrackerEvents[K]> };

/**
 * Headless face (and hand) tracking: webcam -> MediaPipe -> LikenessFrame.
 * No rendering and no render mesh: it loads only the ~0.4 MB landmark model.
 *
 * ```ts
 * const tracker = await LikenessTracker.create({ hands: true });
 * tracker.on("frame", (f) => avatar.apply(f));
 * await tracker.start(); // webcam
 * ```
 *
 * Output conventions are those of LikenessFrame (src/frame.ts): camera frame, metres, x right in
 * the unmirrored image (the subject's left), y up, z towards the camera; ARKit blendshape names.
 */
export class LikenessTracker {
  /** Driver options, live-tunable: changes apply from the next frame. */
  readonly options: DriveOptions;
  /** Rolling per-stage timings in ms (faceDetect, handDetect, drive, frame, trackTotal). */
  readonly perf = new Perf();
  /** The landmark-level face model (its identity is updated by fitIdentity()/setIdentity()). */
  readonly landmarks: LandmarkModel;
  /** The video being tracked. Before start() it is an idle, detached element owned by the tracker. */
  video: HTMLVideoElement;
  /** The last frame produced, or null. */
  lastFrame: LikenessFrame | null = null;
  private faceLm: { x: number; y: number }[] | null = null;
  private handLm: Float32Array[] = [];

  /**
   * Debug/overlay data, not part of LikenessFrame: the latest processed frame's face landmarks in
   * normalized image coordinates (x right, y down, 0..1, unmirrored), or null when no face was found.
   */
  get lastFaceLandmarks(): readonly { x: number; y: number }[] | null { return this.faceLm; }
  /** Debug/overlay data: per detected hand, 21*3 normalized image landmarks (x right, y down, z relative depth). Empty when hands are off. */
  get lastHandLandmarks(): readonly Float32Array[] { return this.handLm; }

  private readonly driver: FaceDriver;
  private handTracker: HandTracker | null = null;
  private handLoading: Promise<HandTracker> | null = null;
  private handsOn: boolean;
  private handFilter = new HandFilterBank();
  private meter: SpeechMeter | null = null;
  private listeners: Listeners = { frame: new Set(), calibrated: new Set(), error: new Set(), start: new Set(), stop: new Set() };
  private ownedStream: MediaStream | null = null;
  private running = false;
  private loopHandle = 0;
  private loopKind: "rvfc" | "raf" | null = null;
  private lastVideoTime = -1;
  private lastTs = -Infinity;
  private tsOffset = 0;
  /** Bumped by stop(): a start() still awaiting the camera or play() notices it was superseded. */
  private startGen = 0;
  private wasCalibrated = false;
  private disposed = false;

  private constructor(
    private face: FaceTracker,
    lm: LandmarkModel,
    private readonly opts: LikenessTrackerOptions,
  ) {
    this.landmarks = lm;
    this.driver = new FaceDriver(lm, MEDIAPIPE_BLENDSHAPES);
    this.options = { ...defaultDriveOptions, ...opts.options };
    if (opts.lipSync !== undefined) this.options.lipSync = opts.lipSync;
    this.handsOn = !!opts.hands;
    this.video = LikenessTracker.makeVideo();
  }

  /** Loads the landmark model and MediaPipe (and the hand model when `hands` is set). */
  static async create(opts: LikenessTrackerOptions = {}): Promise<LikenessTracker> {
    const mp = { wasmUrl: opts.wasmUrl };
    const [lm, face, hands] = await Promise.all([
      LandmarkModel.load(opts.modelUrl ?? assetUrl("ict")),
      FaceTracker.create({ ...mp, modelUrl: opts.faceModelUrl }),
      opts.hands ? HandTracker.create({ ...mp, modelUrl: opts.handModelUrl }) : Promise.resolve(null),
    ]);
    const t = new LikenessTracker(face, lm, opts);
    t.handTracker = hands;
    return t;
  }

  // --- events -----------------------------------------------------------------

  on<K extends keyof LikenessTrackerEvents>(type: K, fn: LikenessTrackerEvents[K]): this {
    (this.listeners[type] as Set<LikenessTrackerEvents[K]>).add(fn);
    return this;
  }

  off<K extends keyof LikenessTrackerEvents>(type: K, fn: LikenessTrackerEvents[K]): this {
    (this.listeners[type] as Set<LikenessTrackerEvents[K]>).delete(fn);
    return this;
  }

  private emit<K extends keyof LikenessTrackerEvents>(type: K, ...args: Parameters<LikenessTrackerEvents[K]>): void {
    for (const fn of this.listeners[type]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        if (type === "error") console.error(err);
        else this.emit("error", toError(err));
      }
    }
  }

  // --- state ------------------------------------------------------------------

  /** True once the neutral-face calibration has finished. */
  get calibrated(): boolean { return this.driver.calibrated; }
  /** Calibration progress, 0..1. */
  get calibration(): number { return this.driver.calibration; }
  /** True between start() and stop(). */
  get isRunning(): boolean { return this.running; }
  /** Whether hand tracking is on. */
  get hands(): boolean { return this.handsOn; }
  /** Whether the microphone speech assist is on. */
  get mic(): boolean { return this.meter !== null; }

  /**
   * Camera-pixel -> head-model similarity of the latest face frame (driver.lastSim): maps
   * centred camera pixels (x right, y up, z towards the camera) into the ICT model frame
   * (metres). Use it to project video onto the model, e.g. for texture capture.
   */
  get lastProjection(): Similarity | null { return this.lastFrame?.face ? this.driver.lastSim : null; }
  /** ICT expression weights (filtered), in `ictNames` order, for the bundled ICT renderer. */
  get ictWeights(): Float32Array { return this.driver.weights; }
  /** ICT expression names ("jawOpen", "mouthSmile_L", ...), the order of `ictWeights`. */
  get ictNames(): readonly string[] { return this.driver.expressionNames; }
  /** Focal length (video pixels) assumed for the current video, from `hfov`. */
  get focalPx(): number {
    return focalFromFov(this.video.videoWidth || 1280, this.opts.hfov ?? DEFAULT_HFOV_DEG);
  }

  /** Restarts the neutral-face calibration (~1.5 s of frames; ask the user to relax their face). */
  calibrate(): void {
    this.driver.calibrate();
    this.wasCalibrated = false;
  }

  /**
   * Fits ICT identity coefficients to the calibrated neutral face and applies them to the tracker's
   * landmark model. Returns them (to apply to a render mesh), or null before calibration.
   */
  fitIdentity(): Float32Array | null {
    return this.driver.fitIdentity();
  }

  /** Applies identity coefficients (e.g. a saved fitIdentity() result) to the tracker's landmark model. */
  setIdentity(coeffs: ArrayLike<number>): void {
    this.driver.setIdentity(coeffs);
  }

  /** Turns hand tracking on or off; loads the hand model the first time. */
  async setHands(on: boolean): Promise<void> {
    this.handsOn = on;
    if (!on || this.handTracker) return;
    this.handLoading ??= HandTracker.create({ wasmUrl: this.opts.wasmUrl, modelUrl: this.opts.handModelUrl });
    try {
      this.handTracker = await this.handLoading;
    } catch (err) {
      this.handsOn = false;
      this.handLoading = null;
      throw err;
    } finally {
      if (this.disposed) this.handTracker?.close();
    }
  }

  /**
   * Turns the microphone speech assist on or off. It asks for microphone access and opens the
   * mouth with speech energy when the camera under-reports lip motion (strength: options.micGain).
   */
  async setMic(on: boolean): Promise<void> {
    if (!on) {
      this.meter?.stop();
      this.meter = null;
      this.driver.speech = 0;
      return;
    }
    if (this.meter) return;
    const meter = await SpeechMeter.start();
    if (this.disposed) meter.stop();
    else this.meter = meter;
  }

  // --- running ----------------------------------------------------------------

  /**
   * Starts tracking. Default source: the webcam at 1280x720, user-facing. A MediaStream or
   * camera constraints play in the tracker's own hidden <video>; a given <video> is used as is
   * (it is played if paused). Calibration restarts. Resolves once frames are flowing.
   */
  async start(source: TrackerSource = {}): Promise<void> {
    if (this.disposed) throw new Error("LikenessTracker: start() after dispose()");
    this.stop();
    const gen = this.startGen;
    try {
      let video: HTMLVideoElement;
      if (isVideo(source)) {
        video = source;
      } else {
        const stream = isStream(source)
          ? source
          : await navigator.mediaDevices.getUserMedia({ video: source.camera ?? DEFAULT_CAMERA, audio: false });
        if (gen !== this.startGen) {
          // stop(), dispose() or another start() ran while the camera was opening: don't leak it.
          if (!isStream(source)) stream.getTracks().forEach((t) => t.stop());
          throw superseded();
        }
        if (!isStream(source)) this.ownedStream = stream;
        video = this.video.dataset.likenessOwned ? this.video : LikenessTracker.makeVideo();
        video.srcObject = stream;
      }
      this.video = video;
      if (video.paused) await video.play();
      if (gen !== this.startGen) throw superseded(); // its stop() already released the camera
      this.calibrate();
      this.running = true;
      this.lastVideoTime = -1;
      this.schedule();
      this.emit("start", video);
    } catch (err) {
      const e = toError(err);
      if (gen !== this.startGen) throw e; // superseded by stop()/start(): its state is not ours to clean up
      this.stopStream();
      this.emit("error", e);
      throw e;
    }
  }

  /** Stops the loop and releases a camera the tracker opened. Listeners stay; start() again to resume. */
  stop(): void {
    this.startGen++;
    if (this.loopKind === "rvfc") this.video.cancelVideoFrameCallback?.(this.loopHandle);
    else if (this.loopKind === "raf") cancelAnimationFrame(this.loopHandle);
    this.loopKind = null;
    this.stopStream();
    if (!this.running) return;
    this.running = false;
    this.emit("stop");
  }

  /** stop(), then releases MediaPipe, the microphone and all listeners. The tracker cannot be reused. */
  dispose(): void {
    this.stop();
    this.disposed = true;
    this.meter?.stop();
    this.meter = null;
    this.face.close();
    this.handTracker?.close();
    this.handTracker = null;
    for (const set of Object.values(this.listeners)) set.clear();
  }

  /**
   * Processes one video frame by hand, for custom loops or offline video (don't mix with start()).
   * `timestampMs` must increase from call to call (e.g. video.currentTime * 1000 for a file); it
   * also drives the temporal filters and becomes LikenessFrame.t. Emits "frame" (and
   * "calibrated"), and returns the frame, or null if the video has no frame data yet.
   */
  process(video: HTMLVideoElement, timestampMs: number): LikenessFrame | null {
    if (this.disposed || video.readyState < 2 || !video.videoWidth) return null;
    // MediaPipe rejects non-increasing timestamps.
    // MediaPipe needs increasing timestamps. If the caller's clock jumps back (e.g. a looping file fed
    // with currentTime), shift it forward by one frame past the last one instead of clamping, so the
    // filters keep seeing realistic frame intervals.
    let ts = timestampMs + this.tsOffset;
    if (ts <= this.lastTs) {
      this.tsOffset += this.lastTs - ts + 1000 / 30;
      ts = timestampMs + this.tsOffset;
    }
    this.lastTs = ts;
    const t0 = performance.now();
    const perf = this.perf;

    const face = perf.time("faceDetect", () => this.face.detect(video, ts));
    const handFrames = this.handsOn && this.handTracker ? perf.time("handDetect", () => this.handTracker!.detect(video, ts)) : [];

    const frame = perf.time("frame", () => {
      const W = video.videoWidth, H = video.videoHeight;
      const focalPx = focalFromFov(W, this.opts.hfov ?? DEFAULT_HFOV_DEG);
      let faceOut = null;
      if (face) {
        this.driver.speech = this.meter ? this.meter.level() : 0;
        perf.time("drive", () => this.driver.update(face, this.options, true, ts / 1000));
        const sim = this.driver.lastSim;
        // A degenerate alignment (collapsed landmarks) gives a NaN/zero scale: report no face rather than NaN poses.
        if (sim && sim.s > 0 && Number.isFinite(sim.s)) faceOut = buildFaceOutput(this.driver.expressionNames, this.driver.weights, sim, focalPx, this.driver.calibrated);
      }
      const hands: HandOutput[] = this.handsOn ? this.handFilter.update(handFrames, { videoWidth: W, videoHeight: H, focalPx }, ts / 1000) : [];
      return buildFrame(ts, faceOut, hands);
    });
    perf.add("trackTotal", performance.now() - t0);

    this.faceLm = face ? face.normalized : null;
    this.handLm = handFrames.map((h) => h.image);
    this.lastFrame = frame;
    this.emit("frame", frame);
    if (!this.wasCalibrated && this.driver.calibrated) {
      this.wasCalibrated = true;
      this.emit("calibrated");
    }
    return frame;
  }

  // --- internals --------------------------------------------------------------

  private schedule(): void {
    if (!this.running) return;
    const v = this.video;
    if (typeof v.requestVideoFrameCallback === "function") {
      this.loopKind = "rvfc";
      this.loopHandle = v.requestVideoFrameCallback(() => this.tick());
    } else {
      this.loopKind = "raf";
      this.loopHandle = requestAnimationFrame(() => this.tick());
    }
  }

  private tick(): void {
    if (!this.running) return;
    const v = this.video;
    // rVFC fires once per new frame; with rAF, skip until the video has advanced.
    if (v.currentTime !== this.lastVideoTime && !v.paused) {
      this.lastVideoTime = v.currentTime;
      try {
        this.process(v, performance.now());
      } catch (err) {
        this.emit("error", toError(err));
      }
    }
    this.schedule();
  }

  private stopStream(): void {
    if (this.ownedStream) {
      this.ownedStream.getTracks().forEach((t) => t.stop());
      this.ownedStream = null;
    }
    // Also detach a caller's MediaStream from our hidden <video>, so it stops decoding and `paused` is true.
    if (this.video.dataset.likenessOwned && this.video.srcObject) {
      this.video.pause();
      this.video.srcObject = null;
    }
  }

  private static makeVideo(): HTMLVideoElement {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.dataset.likenessOwned = "1";
    return v;
  }
}

function isVideo(s: TrackerSource): s is HTMLVideoElement {
  return typeof HTMLVideoElement !== "undefined" && s instanceof HTMLVideoElement;
}
function isStream(s: TrackerSource): s is MediaStream {
  return typeof MediaStream !== "undefined" && s instanceof MediaStream;
}
function superseded(): Error {
  const e = new Error("LikenessTracker: start() was cancelled by stop(), dispose() or a newer start()");
  e.name = "AbortError";
  return e;
}
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
