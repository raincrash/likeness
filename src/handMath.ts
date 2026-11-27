import type { HandOutput } from "./frame.js";

// Pure hand maths shared by the tracker, the rig and the Node tests: no DOM, no MediaPipe, no loaders.

export type Handedness = "Left" | "Right";

/** WebXR hand joints, in XRHand order (parents always come before their children). */
export const XR_JOINTS = [
  "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
  "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
  "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
  "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip",
] as const;
export const N_JOINTS = XR_JOINTS.length; // 25
export const N_LANDMARKS = 21;

/** MediaPipe landmark -> the XR joint at the same anatomical point. The finger metacarpals have no landmark. */
export const LANDMARK_JOINT = [0, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 24];

/** MediaPipe's hand skeleton (same pairs as HandLandmarker.HAND_CONNECTIONS). */
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** Palm segments (wrist to the MCPs) used for size and depth: rigid, unlike the fingers. */
export const PALM_SEGMENTS: [number, number][] = [[0, 5], [0, 9], [0, 13], [0, 17]];
const PALM_POINTS = [0, 5, 9, 13, 17];

type Ref = "lateral" | "normal";
interface BoneSpec {
  /** Parent joint for forward kinematics (-1 for the wrist). */
  parent: number;
  /** The bone axis is landmark `from` -> landmark `to` (on the model, the joints at those landmarks). */
  from: number;
  to: number;
  /** Twist reference: the palm's lateral axis (across the palm, towards the index) or the palm normal. */
  ref: Ref;
}

/** How each XR joint is driven. Tips copy the direction of the bone before them. */
export const BONES: BoneSpec[] = (() => {
  const b: BoneSpec[] = [{ parent: -1, from: 0, to: 9, ref: "lateral" }];
  // Thumb: CMC (1), MCP (2), IP (3), tip (4). Its bones swing across the palm, so twist from the palm normal.
  b.push({ parent: 0, from: 1, to: 2, ref: "normal" }, { parent: 1, from: 2, to: 3, ref: "normal" },
    { parent: 2, from: 3, to: 4, ref: "normal" }, { parent: 3, from: 3, to: 4, ref: "normal" });
  // Fingers: metacarpal runs wrist -> MCP; then MCP -> PIP -> DIP -> tip. They flex about the lateral axis.
  for (const mcp of [5, 9, 13, 17]) {
    const j = b.length;
    b.push({ parent: 0, from: 0, to: mcp, ref: "lateral" }, { parent: j, from: mcp, to: mcp + 1, ref: "lateral" },
      { parent: j + 1, from: mcp + 1, to: mcp + 2, ref: "lateral" }, { parent: j + 2, from: mcp + 2, to: mcp + 3, ref: "lateral" },
      { parent: j + 3, from: mcp + 2, to: mcp + 3, ref: "lateral" });
  }
  return b;
})();

// --- handedness ------------------------------------------------------------------

/**
 * The subject's own hand from MediaPipe's handedness label. MediaPipe Tasks labels the chirality of
 * the hand as it appears in the image it was given (tasks docs: "Left and Right handedness
 * correspond to the subject's hands ... Passing a horizontally mirrored image will invert these
 * outputs"), unlike the legacy Hands solution, which assumed selfie-mirrored input. Our video
 * frames are not mirrored, so the label is used as is; pass inputMirrored for a flipped source.
 */
export function subjectHandedness(label: string, inputMirrored = false): Handedness | null {
  const l = label.toLowerCase();
  const h: Handedness | null = l === "left" ? "Left" : l === "right" ? "Right" : null;
  if (!h || !inputMirrored) return h;
  return h === "Left" ? "Right" : "Left";
}

/**
 * Chirality from the landmarks' 3D shape, in any right-handed frame (MediaPipe's x right, y down,
 * z away, or ours: x right, y up, z towards the camera). Fingers curl towards the palm, and for a
 * right hand (index MCP - wrist) x (pinky MCP - wrist) points out of the palm. Returns a signed
 * score: > 0 right, < 0 left; only meaningful when the fingers are visibly curled.
 */
export function chiralityScore(p: ArrayLike<number>): number {
  const a = sub(p, 5, 0), b = sub(p, 17, 0);
  const n = cross(a, b);
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  let dot = 0;
  for (const [tip, mcp] of [[8, 5], [12, 9], [16, 13], [20, 17]]) {
    // How far the fingertip leaves the line of its metacarpal (wrist -> MCP), so a straight finger
    // scores 0 however the palm triangle is tilted.
    const c = sub(p, tip, mcp), m = sub(p, mcp, 0);
    const s = Math.hypot(c[0], c[1], c[2]) / (Math.hypot(m[0], m[1], m[2]) || 1);
    dot += ((c[0] - s * m[0]) * n[0] + (c[1] - s * m[1]) * n[1] + (c[2] - s * m[2]) * n[2]) / nl;
  }
  const size = Math.hypot(a[0], a[1], a[2]) || 1;
  return dot / size;
}

function sub(p: ArrayLike<number>, i: number, j: number): [number, number, number] {
  return [p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]];
}
function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// --- depth and placement -------------------------------------------------------------

/** Mean wrist-to-MCP length of 21*3 points (any units). */
export function palmSize(p: ArrayLike<number>): number {
  let sum = 0;
  for (const [i, j] of PALM_SEGMENTS) sum += Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
  return sum / PALM_SEGMENTS.length;
}

/**
 * Where the hand is: the palm centroid (wrist and MCPs) in camera metric space, X right, Y up,
 * Z = distance from the camera, all metres. The world landmarks give the hand's metric shape in
 * camera axes, so only its translation is unknown, and under full perspective that is linear:
 * for each landmark, u (Tz + wz) = Tx + wx and v (Tz + wz) = Ty + wy, with u, v the pixel offsets
 * from the image centre over f. Least squares over all 21 landmarks. For a fronto-parallel palm this
 * reduces to Z = f * L_world / L_px; unlike that ratio it stays right when the palm tilts or sits
 * off-axis (perspective parallax). Returns null for a degenerate (collapsed) projection.
 *
 * image: 21*3 normalized landmarks; world: 21*3 metres (MediaPipe axes: x right, y down, z away).
 */
export function estimatePalm(image: ArrayLike<number>, world: ArrayLike<number>, width: number, height: number, focalPx: number): { X: number; Y: number; Z: number } | null {
  // Normal equations of rows [1 0 -u | u wz - wx] and [0 1 -v | v wz - wy].
  let n = 0, su = 0, sv = 0, suu = 0, bx = 0, by = 0, bz = 0;
  for (let i = 0; i < N_LANDMARKS; i++) {
    const u = (image[i * 3] * width - width / 2) / focalPx, v = (image[i * 3 + 1] * height - height / 2) / focalPx;
    const wx = world[i * 3], wy = world[i * 3 + 1], wz = world[i * 3 + 2];
    const rx = u * wz - wx, ry = v * wz - wy;
    n++; su += u; sv += v; suu += u * u + v * v;
    bx += rx; by += ry; bz -= u * rx + v * ry;
  }
  // [[n, 0, -su], [0, n, -sv], [-su, -sv, suu]] T = [bx, by, bz]; eliminate Tx, Ty.
  const det = suu - (su * su + sv * sv) / n; // = sum of squared (u, v) deviations
  if (!(det > 1e-8 * n)) return null;
  const Tz = (bz + (su * bx + sv * by) / n) / det;
  const Tx = (bx + su * Tz) / n, Ty = (by + sv * Tz) / n;
  const c = palmCentroids(image, world, width, height);
  return { X: Tx + c.wx, Y: -(Ty + c.wy), Z: Tz + c.wz };
}

/** Distance of the palm centroid from the camera in metres (NaN if degenerate); see estimatePalm(). */
export function estimateDepth(image: ArrayLike<number>, world: ArrayLike<number>, width: number, height: number, focalPx: number): number {
  return estimatePalm(image, world, width, height, focalPx)?.Z ?? NaN;
}

/**
 * A HandFrame as the public LikenessFrame hand (src/frame.ts): 21 joints in MediaPipe order, camera
 * frame (x right, y up, z towards the camera, so the hand is at negative z), metres, unsmoothed.
 * Returns null when the hand cannot be placed.
 */
export function toHandOutput(
  hand: { handedness: Handedness; score: number; image: ArrayLike<number>; world: ArrayLike<number> },
  cam: { videoWidth: number; videoHeight: number; focalPx: number },
): HandOutput | null {
  const p = estimatePalm(hand.image, hand.world, cam.videoWidth, cam.videoHeight, cam.focalPx);
  if (!p) return null;
  const c = palmCentroids(hand.image, hand.world, cam.videoWidth, cam.videoHeight);
  const pts = cameraPoints(hand.world, c, p.X, p.Y, p.Z, new Float32Array(N_LANDMARKS * 3));
  const joints: [number, number, number][] = [];
  for (let i = 0; i < N_LANDMARKS; i++) joints.push([pts[i * 3], pts[i * 3 + 1], -pts[i * 3 + 2]]);
  return { side: hand.handedness === "Left" ? "left" : "right", score: hand.score, joints };
}

/** Horizontal FOV (degrees) -> focal length in pixels. */
export function focalFromFov(width: number, hfovDeg = 65): number {
  return width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
}

/** Image centroid of the palm (wrist and MCPs) in pixels, and the world centroid of the same points. */
export function palmCentroids(image: ArrayLike<number>, world: ArrayLike<number>, width: number, height: number) {
  let ix = 0, iy = 0, wx = 0, wy = 0, wz = 0;
  for (const i of PALM_POINTS) {
    ix += image[i * 3] * width; iy += image[i * 3 + 1] * height;
    wx += world[i * 3]; wy += world[i * 3 + 1]; wz += world[i * 3 + 2];
  }
  const n = PALM_POINTS.length;
  return { ix: ix / n, iy: iy / n, wx: wx / n, wy: wy / n, wz: wz / n };
}

/** Pixel -> camera metric (X right, Y up, metres, relative to the optical axis) at distance Z. */
export function pixelToCamera(xPx: number, yPx: number, width: number, height: number, focalPx: number, Z: number): [number, number] {
  return [((xPx - width / 2) * Z) / focalPx, (-(yPx - height / 2) * Z) / focalPx];
}

/**
 * Landmarks in camera metric space: the palm centroid sits at (X, Y, Z), and the world landmarks
 * (MediaPipe convention: x right, y down, z away from the camera) give the shape around it.
 * out: 21*3 as (X right, Y up, Z = distance from the camera).
 */
export function cameraPoints(world: ArrayLike<number>, centroid: { wx: number; wy: number; wz: number }, X: number, Y: number, Z: number, out: Float32Array): Float32Array {
  for (let i = 0; i < N_LANDMARKS; i++) {
    out[i * 3] = X + (world[i * 3] - centroid.wx);
    out[i * 3 + 1] = Y - (world[i * 3 + 1] - centroid.wy);
    out[i * 3 + 2] = Z + (world[i * 3 + 2] - centroid.wz);
  }
  return out;
}

// --- anatomical constraints -------------------------------------------------------------------

/** Index..pinky landmark chains: [MCP, PIP, DIP, TIP]. */
const FINGER_CHAINS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
/** Largest bend at the PIP / DIP joints (radians). */
const MAX_FLEX = [(115 * Math.PI) / 180, (90 * Math.PI) / 180];

/**
 * Makes noisy finger poses anatomically plausible, in place. MediaPipe's per-joint depth is the
 * noisiest part of the estimate, and it shows as fingers bending sideways or backwards. For each
 * finger (not the thumb):
 *  - PIP and DIP are hinges: the middle and distal segments are projected onto the finger's
 *    bending plane (spanned by the proximal segment and the palm normal), removing sideways kinks;
 *  - no hyperextension: a joint bending against the finger's overall bend direction is
 *    straightened, and bends are capped at 115 deg (PIP) / 90 deg (DIP);
 *  - the DIP follows the PIP part of the way (real fingers couple them, DIP ~ 2/3 PIP).
 * Segment lengths are kept. pts: 21*3 positions in any right-handed metric frame.
 */
export function constrainFingers(pts: Float32Array): Float32Array {
  const P = (i: number): [number, number, number] => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a: number[]) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  const w = P(0);
  const palmN = norm(cross(sub(P(5), w), sub(P(17), w)));
  if (!Number.isFinite(palmN[0]) || len(palmN) < 0.5) return pts;

  for (const [mcp, pip, dip, tip] of FINGER_CHAINS) {
    const a = P(mcp), b = P(pip), c = P(dip), d = P(tip);
    const d1 = norm(sub(b, a));
    // Hinge axis: perpendicular to the proximal segment within the palm's lateral direction.
    let h = cross(d1, palmN);
    if (len(h) < 1e-6) continue;
    h = norm(h);
    const fwd = d1, side = cross(h, fwd); // in-plane basis: fwd (along the finger), side (towards the palm normal)
    const angleOf = (v: number[]) => Math.atan2(dot(v, side), dot(v, fwd));
    const l2 = len(sub(c, b)), l3 = len(sub(d, c));
    if (l2 < 1e-6 || l3 < 1e-6) continue;
    // Absolute bend angles of the two outer segments, measured in the bending plane.
    let t2 = angleOf(sub(c, b));
    let t3 = angleOf(sub(d, c)) - t2;
    // The finger's overall bend direction (sign): whichever way it curls most.
    const sgn = Math.sign(t2 + t3) || 1;
    if (Math.sign(t2) !== sgn) t2 = 0; // hyperextension at the PIP: straighten
    if (Math.sign(t3) !== sgn) t3 = 0; // hyperextension at the DIP
    t2 = sgn * Math.min(Math.abs(t2), MAX_FLEX[0]);
    const coupled = 0.5 * t3 + 0.5 * (2 / 3) * t2; // t2 and t3 now share the sign sgn (or are 0)
    t3 = sgn * Math.min(Math.abs(coupled), MAX_FLEX[1]);
    const dir = (t: number) => [fwd[0] * Math.cos(t) + side[0] * Math.sin(t), fwd[1] * Math.cos(t) + side[1] * Math.sin(t), fwd[2] * Math.cos(t) + side[2] * Math.sin(t)];
    const e2 = dir(t2), e3 = dir(t2 + t3);
    const nc = [b[0] + e2[0] * l2, b[1] + e2[1] * l2, b[2] + e2[2] * l2];
    const nd = [nc[0] + e3[0] * l3, nc[1] + e3[1] * l3, nc[2] + e3[2] * l3];
    pts.set(nc, dip * 3);
    pts.set(nd, tip * 3);
  }
  return pts;
}
