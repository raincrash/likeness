import { OneEuro } from "./solver.js";
import type { HandOutput } from "./frame.js";
import { N_LANDMARKS, cameraPoints, constrainFingers, estimatePalm, palmCentroids, pixelToCamera, type Handedness } from "./handMath.js";

/** The raw per-hand detection the smoother consumes (a subset of HandFrame). */
export interface HandDetection {
  handedness: Handedness;
  score: number;
  /** 21*3 normalized image landmarks (x right, y down). */
  image: ArrayLike<number>;
  /** 21*3 world landmarks, metres, MediaPipe axes (x right, y down, z away). */
  world: ArrayLike<number>;
}

export interface CameraIntrinsics {
  videoWidth: number;
  videoHeight: number;
  /** Focal length in video pixels. */
  focalPx: number;
}

/** Depth range we accept (m); outside it the estimate is treated as a glitch. */
const MIN_Z = 0.12, MAX_Z = 3;
/** A hand unseen for this long starts fresh (its filters reset). */
const RESET_AFTER = 0.3;

/**
 * Smooths one hand over time: depth, palm position and hand shape each get a
 * One Euro filter, so the hand neither jitters when still nor lags when moving.
 * Output: 21*3 camera-metric points (X right, Y up, Z = distance from camera, m).
 */
export class HandSmoother {
  /** Smoothed distance from the camera (m); NaN before the first estimate. */
  depth = NaN;
  lastSeen = -Infinity;
  private fWorld = this.makeWorld();
  private fXY = new OneEuro(2, new Float32Array(2).fill(2), 3, 1);
  private fZ = new OneEuro(1, new Float32Array(1).fill(0.6), 0.6, 1);
  private world = new Float32Array(63);
  private buf = new Float32Array(2);
  readonly cam: Float32Array = new Float32Array(N_LANDMARKS * 3);

  private makeWorld() {
    return new OneEuro(63, new Float32Array(63).fill(2.5), 8, 1);
  }

  reset(): void {
    this.fWorld = this.makeWorld();
    this.fXY = new OneEuro(2, new Float32Array(2).fill(2), 3, 1);
    this.fZ = new OneEuro(1, new Float32Array(1).fill(0.6), 0.6, 1);
    this.depth = NaN;
  }

  /** Returns the smoothed camera points (this.cam), or null when nothing sensible can be placed yet. */
  push(frame: HandDetection, ctx: CameraIntrinsics, tSec: number): Float32Array | null {
    if (tSec - this.lastSeen > RESET_AFTER) this.reset();
    const W = ctx.videoWidth, H = ctx.videoHeight, f = ctx.focalPx;
    const palm = estimatePalm(frame.image, frame.world, W, H, f);
    let z = palm ? palm.Z : NaN;
    if (!palm || !(z > MIN_Z && z < MAX_Z)) {
      if (!Number.isFinite(this.depth)) return null;
      z = this.depth; // degenerate or a glitch: hold the depth
    }
    this.buf[0] = z;
    this.fZ.filter(this.buf.subarray(0, 1), tSec, this.buf.subarray(0, 1));
    this.depth = this.buf[0];

    // Palm position at the smoothed depth, along the palm centroid's viewing ray.
    const c = palmCentroids(frame.image, frame.world, W, H);
    const [X, Y] = palm && palm.Z > 0 ? [(palm.X * this.depth) / palm.Z, (palm.Y * this.depth) / palm.Z] : pixelToCamera(c.ix, c.iy, W, H, f, this.depth);
    this.buf[0] = X;
    this.buf[1] = Y;
    this.fXY.filter(this.buf, tSec, this.buf);
    this.fWorld.filter(Float32Array.from(frame.world), tSec, this.world);
    // Re-centre the smoothed shape on its own palm centroid.
    const cw = palmCentroids(frame.image, this.world, W, H);
    cameraPoints(this.world, cw, this.buf[0], this.buf[1], this.depth, this.cam);
    constrainFingers(this.cam);
    this.lastSeen = tSec;
    return this.cam;
  }
}

/** Smoothers for both hands; turns raw detections into public HandOutputs. */
export class HandFilterBank {
  readonly left = new HandSmoother();
  readonly right = new HandSmoother();

  update(hands: HandDetection[], ctx: CameraIntrinsics, tSec: number): HandOutput[] {
    const out: HandOutput[] = [];
    for (const h of hands) {
      const s = h.handedness === "Left" ? this.left : this.right;
      const cam = s.push(h, ctx, tSec);
      if (!cam) continue;
      const joints: [number, number, number][] = [];
      for (let i = 0; i < N_LANDMARKS; i++) joints.push([cam[i * 3], cam[i * 3 + 1], -cam[i * 3 + 2]]);
      out.push({ side: h.handedness === "Left" ? "left" : "right", score: h.score, joints });
    }
    return out;
  }
}
