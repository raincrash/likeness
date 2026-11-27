/**
 * LikenessFrame: the public, renderer-independent output of likeness, one per
 * tracked video frame. This is what the streaming bridge sends and what
 * external avatars (VRM, Unity, Unreal, VTuber apps) consume.
 *
 * Conventions (all "subject space", NOT mirrored):
 * - Camera frame: right-handed, metres, origin at the camera; x points to the
 *   right of the (unmirrored) camera image, which is the subject's left; y up;
 *   z from the subject towards the camera (so the subject is at negative z).
 * - Head rotation is the head's orientation in that camera frame; identity =
 *   looking straight into the camera.
 * - "Left"/"right" always mean the subject's own left/right.
 * - Blendshape names are Apple ARKit's 52 names exactly as MediaPipe spells
 *   them ("jawOpen", "eyeBlinkLeft", ...), values 0..1, after calibration,
 *   lip-sync fitting and smoothing.
 */

export const ARKIT_BLENDSHAPES = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "cheekPuff",
  "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
  "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight",
  "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft",
  "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight",
  "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft", "mouthSmileRight",
  "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight",
  "tongueOut",
] as const;

export type ArkitName = (typeof ARKIT_BLENDSHAPES)[number];

/** MediaPipe hand landmark order (21 joints). */
export const HAND_JOINTS = [
  "wrist",
  "thumbCmc", "thumbMcp", "thumbIp", "thumbTip",
  "indexMcp", "indexPip", "indexDip", "indexTip",
  "middleMcp", "middlePip", "middleDip", "middleTip",
  "ringMcp", "ringPip", "ringDip", "ringTip",
  "pinkyMcp", "pinkyPip", "pinkyDip", "pinkyTip",
] as const;

export interface FaceOutput {
  blendshapes: Record<ArkitName, number>;
  head: {
    /** Quaternion [x, y, z, w] in the camera frame. */
    rotation: [number, number, number, number];
    /** Approximate head centre in the camera frame, metres (z negative = in front of the camera). */
    position: [number, number, number];
  };
  /** True once the neutral-face calibration has finished. */
  calibrated: boolean;
}

export interface HandOutput {
  side: "left" | "right";
  score: number;
  /** 21 joints in HAND_JOINTS order, camera frame, metres. */
  joints: [number, number, number][];
}

export interface LikenessFrame {
  /** Format version, bumped on breaking changes. */
  v: 1;
  /** Milliseconds, monotonic (performance.now() of the source). */
  t: number;
  face: FaceOutput | null;
  hands: HandOutput[];
}

/**
 * Converts ICT-FaceKit expression weights (driver.weights, ICT names such as
 * "mouthSmile_L") into the 52 ARKit names. ICT splits browInnerUp and
 * cheekPuff into halves (averaged back) and has no tongueOut (always 0).
 */
export function ictToArkit(ictNames: readonly string[], weights: ArrayLike<number>): Record<ArkitName, number> {
  const { target, count } = ictPlan(ictNames);
  ictSums.fill(0);
  for (let i = 0; i < target.length; i++) if (target[i] >= 0) ictSums[target[i]] += weights[i];
  const out = {} as Record<ArkitName, number>;
  for (let k = 0; k < ARKIT_BLENDSHAPES.length; k++) {
    out[ARKIT_BLENDSHAPES[k]] = count[k] ? Math.min(1, Math.max(0, ictSums[k] / count[k])) : 0;
  }
  return out;
}

const ARKIT_INDEX = new Map<string, number>(ARKIT_BLENDSHAPES.map((n, k) => [n, k]));

/**
 * The ARKit name an ICT expression maps to: "mouthSmile_L" -> "mouthSmileLeft", the split halves
 * "browInnerUp_L"/"_R" and "cheekPuff_L"/"_R" -> "browInnerUp"/"cheekPuff", or null for ICT-only
 * shapes (PupilDilate, cheekRaiser). Shared by ictToArkit and the avatar's inverse mapping.
 */
export function ictArkitName(ict: string): ArkitName | null {
  const sided = ict.replace(/_L$/, "Left").replace(/_R$/, "Right");
  if (ARKIT_INDEX.has(sided)) return sided as ArkitName;
  const unsided = ict.replace(/_[LR]$/, "");
  return ARKIT_INDEX.has(unsided) ? (unsided as ArkitName) : null;
}

// ictToArkit runs every frame: the name matching is done once per names array.
const ictSums = new Float64Array(ARKIT_BLENDSHAPES.length);
const ictPlans = new WeakMap<readonly string[], { target: Int16Array; count: Uint8Array }>();
function ictPlan(ictNames: readonly string[]) {
  let plan = ictPlans.get(ictNames);
  if (plan && plan.target.length === ictNames.length) return plan;
  const target = Int16Array.from(ictNames, (ict) => {
    const a = ictArkitName(ict);
    return a ? ARKIT_INDEX.get(a)! : -1;
  });
  const count = new Uint8Array(ARKIT_BLENDSHAPES.length);
  for (const k of target) if (k >= 0) count[k]++;
  plan = { target, count };
  ictPlans.set(ictNames, plan);
  return plan;
}
