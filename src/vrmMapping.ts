/**
 * Pure (no three.js, no DOM) mapping from LikenessFrame data onto VRM avatars:
 * ARKit blendshapes -> VRM expression weights, perfect-sync name matching,
 * left/right mirroring, eye gaze -> VRM lookAt yaw/pitch, and the camera-frame
 * -> VRM model-frame quaternion conversion. Runs in Node so it can be unit tested.
 *
 * Everything that runs per frame works on preallocated typed arrays indexed in
 * ARKIT_BLENDSHAPES order and does not allocate.
 */
import { ARKIT_BLENDSHAPES, type ArkitName } from "./frame.js";

export const N_ARKIT = ARKIT_BLENDSHAPES.length; // 52

const ARKIT_INDEX: ReadonlyMap<string, number> = new Map(ARKIT_BLENDSHAPES.map((n, i) => [n, i]));

/** Index of an ARKit name in ARKIT_BLENDSHAPES (throws on unknown names, so tables fail loudly). */
export function arkitIndex(name: ArkitName): number {
  const i = ARKIT_INDEX.get(name);
  if (i === undefined) throw new Error(`unknown ARKit blendshape "${name}"`);
  return i;
}

// --- mirroring ----------------------------------------------------------------

/** The ARKit name with the subject's left and right swapped ("eyeBlinkLeft" <-> "eyeBlinkRight", "jawLeft" <-> "jawRight"). */
export function mirrorArkitName(name: ArkitName): ArkitName {
  const m = name.endsWith("Left") ? name.slice(0, -4) + "Right" : name.endsWith("Right") ? name.slice(0, -5) + "Left" : name;
  return (ARKIT_INDEX.has(m) ? m : name) as ArkitName;
}

/** MIRROR_PERMUTATION[i] = index of the blendshape that lands on i when mirrored. */
export const MIRROR_PERMUTATION: Int16Array = Int16Array.from(ARKIT_BLENDSHAPES, (n) => arkitIndex(mirrorArkitName(n)));

/** dst[i] = src[mirror(i)]. src and dst must be different arrays. */
export function mirrorWeights(src: ArrayLike<number>, dst: Float32Array): Float32Array {
  for (let i = 0; i < N_ARKIT; i++) dst[i] = src[MIRROR_PERMUTATION[i]];
  return dst;
}

/** Copies a LikenessFrame blendshape record into an ARKit-ordered array, optionally mirrored. Allocation-free. */
export function readBlendshapes(src: Readonly<Record<ArkitName, number>>, dst: Float32Array, mirror = false): Float32Array {
  for (let i = 0; i < N_ARKIT; i++) {
    const v = src[ARKIT_BLENDSHAPES[mirror ? MIRROR_PERMUTATION[i] : i]];
    dst[i] = v > 0 ? (v < 1 ? v : 1) : 0; // also maps NaN/undefined to 0
  }
  return dst;
}

// --- ARKit -> VRM preset table ------------------------------------------------

/** The VRM 1.0 preset expressions likeness drives. three-vrm renames VRM 0.x presets
 * (a/i/u/e/o, joy, sorrow, blink_l, ...) to these, so the table covers both versions. */
export const DRIVEN_PRESETS = [
  "aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight", "happy", "angry", "sad", "surprised",
] as const;
export type DrivenPreset = (typeof DRIVEN_PRESETS)[number];

/**
 * One additive term of a preset's formula.
 * - `mean`: w * average of the named blendshapes.
 * - `min`:  w * minimum of the named blendshapes.
 */
export type Term = { mean: readonly ArkitName[]; w: number } | { min: readonly ArkitName[]; w: number };

/** gate(x) = smoothstep(lo, hi, mean(of)): multiplies the whole formula. */
export interface Gate {
  of: readonly ArkitName[];
  lo: number;
  hi: number;
}

/**
 * weight(preset) = clamp01( (bias + Σ terms) * Π gates )
 * Visemes (aa/ih/ou/ee/oh) are then scaled together so they sum to at most 1.
 */
export interface PresetRule {
  preset: DrivenPreset;
  terms: readonly Term[];
  bias?: number;
  gates?: readonly Gate[];
  /** Short human-readable description, used in the docs table. */
  note: string;
}

const SMILE = ["mouthSmileLeft", "mouthSmileRight"] as const;
const STRETCH = ["mouthStretchLeft", "mouthStretchRight"] as const;
const OPEN: Gate["of"] = ["jawOpen"];

/** The ARKit -> VRM preset mapping. Edit here; tests and docs/vrm.md describe the intent. */
export const PRESET_RULES: readonly PresetRule[] = [
  // Visemes. jawOpen alone reads as "aa"; rounded lips steal from it.
  { preset: "aa", terms: [{ mean: ["jawOpen"], w: 1.2 }, { mean: ["mouthFunnel", "mouthPucker"], w: -0.6 }, { mean: STRETCH, w: -0.4 }],
    note: "1.2·jawOpen − 0.6·mean(funnel, pucker) − 0.4·stretch" },
  { preset: "ou", terms: [{ mean: ["mouthPucker"], w: 0.9 }, { mean: ["mouthFunnel"], w: 0.4 }],
    note: "0.9·mouthPucker + 0.4·mouthFunnel" },
  { preset: "oh", terms: [{ mean: ["mouthFunnel"], w: 1.0 }, { mean: ["jawOpen"], w: 0.2 }], gates: [{ of: OPEN, lo: 0.05, hi: 0.25 }],
    note: "(mouthFunnel + 0.2·jawOpen) · open(0.05–0.25)" },
  { preset: "ee", terms: [{ mean: STRETCH, w: 1.2 }, { mean: SMILE, w: 0.4 }], gates: [{ of: OPEN, lo: 0.03, hi: 0.2 }],
    note: "(1.2·mouthStretch + 0.4·mouthSmile) · open(0.03–0.2)" },
  { preset: "ih", terms: [{ mean: SMILE, w: 0.6 }, { mean: STRETCH, w: 0.3 }, { mean: ["jawOpen"], w: 0.3 }], bias: -0.05,
    gates: [{ of: OPEN, lo: 0.02, hi: 0.15 }],
    note: "(0.6·mouthSmile + 0.3·mouthStretch + 0.3·jawOpen − 0.05) · open(0.02–0.15)" },
  // Blinks: the shared part goes to "blink", the rest to the one-sided presets, so they never double up.
  { preset: "blink", terms: [{ min: ["eyeBlinkLeft", "eyeBlinkRight"], w: 1 }], note: "min(eyeBlinkLeft, eyeBlinkRight)" },
  { preset: "blinkLeft", terms: [{ mean: ["eyeBlinkLeft"], w: 1 }, { min: ["eyeBlinkLeft", "eyeBlinkRight"], w: -1 }],
    note: "eyeBlinkLeft − blink" },
  { preset: "blinkRight", terms: [{ mean: ["eyeBlinkRight"], w: 1 }, { min: ["eyeBlinkLeft", "eyeBlinkRight"], w: -1 }],
    note: "eyeBlinkRight − blink" },
  // Emotions. Biased down so speech and resting faces don't trigger them.
  { preset: "happy", terms: [{ mean: SMILE, w: 0.8 }, { mean: ["cheekSquintLeft", "cheekSquintRight"], w: 0.6 }], bias: -0.15,
    note: "0.8·mouthSmile + 0.6·cheekSquint − 0.15" },
  { preset: "angry", terms: [{ mean: ["browDownLeft", "browDownRight"], w: 1.0 }, { mean: ["noseSneerLeft", "noseSneerRight"], w: 0.3 }], bias: -0.15,
    note: "browDown + 0.3·noseSneer − 0.15" },
  { preset: "sad", terms: [{ mean: ["mouthFrownLeft", "mouthFrownRight"], w: 0.7 }, { mean: ["browInnerUp"], w: 0.6 },
    { mean: ["browOuterUpLeft", "browOuterUpRight"], w: -0.4 }], bias: -0.1,
    note: "0.7·mouthFrown + 0.6·browInnerUp − 0.4·browOuterUp − 0.1" },
  { preset: "surprised", terms: [{ mean: ["browOuterUpLeft", "browOuterUpRight"], w: 0.5 }, { mean: ["eyeWideLeft", "eyeWideRight"], w: 0.5 },
    { mean: ["jawOpen"], w: 0.3 }], bias: -0.1, gates: [{ of: ["browOuterUpLeft", "browOuterUpRight"], lo: 0.1, hi: 0.35 }],
    note: "(0.5·browOuterUp + 0.5·eyeWide + 0.3·jawOpen − 0.1) · browsUp(0.1–0.35)" },
];

export const VISEMES: readonly DrivenPreset[] = ["aa", "ih", "ou", "ee", "oh"];

/** Rules flattened into typed arrays so evaluation is allocation-free. */
export interface CompiledRules {
  presets: readonly DrivenPreset[];
  bias: Float32Array;
  /** Per rule: [termStart, termEnd) into term arrays, [gateStart, gateEnd) into gate arrays. */
  termRange: Uint16Array;
  gateRange: Uint16Array;
  termKind: Uint8Array; // 0 = mean, 1 = min
  termW: Float32Array;
  termIdx: Uint16Array; // per term: [start, end) into idx
  gateLo: Float32Array;
  gateHi: Float32Array;
  gateIdx: Uint16Array;
  idx: Uint16Array;
  visemeMask: Uint8Array;
}

export function compileRules(rules: readonly PresetRule[] = PRESET_RULES): CompiledRules {
  const idx: number[] = [], termKind: number[] = [], termW: number[] = [], termIdx: number[] = [];
  const gateLo: number[] = [], gateHi: number[] = [], gateIdx: number[] = [];
  const termRange: number[] = [], gateRange: number[] = [];
  const pushNames = (names: readonly ArkitName[], out: number[]) => {
    out.push(idx.length);
    for (const n of names) idx.push(arkitIndex(n));
    out.push(idx.length);
  };
  for (const r of rules) {
    termRange.push(termW.length);
    for (const t of r.terms) {
      const isMin = "min" in t;
      termKind.push(isMin ? 1 : 0);
      termW.push(t.w);
      pushNames(isMin ? t.min : t.mean, termIdx);
    }
    termRange.push(termW.length);
    gateRange.push(gateLo.length);
    for (const g of r.gates ?? []) {
      gateLo.push(g.lo);
      gateHi.push(g.hi);
      pushNames(g.of, gateIdx);
    }
    gateRange.push(gateLo.length);
  }
  return {
    presets: rules.map((r) => r.preset),
    bias: Float32Array.from(rules, (r) => r.bias ?? 0),
    termRange: Uint16Array.from(termRange),
    gateRange: Uint16Array.from(gateRange),
    termKind: Uint8Array.from(termKind),
    termW: Float32Array.from(termW),
    termIdx: Uint16Array.from(termIdx),
    gateLo: Float32Array.from(gateLo),
    gateHi: Float32Array.from(gateHi),
    gateIdx: Uint16Array.from(gateIdx),
    idx: Uint16Array.from(idx),
    visemeMask: Uint8Array.from(rules, (r) => (VISEMES.includes(r.preset) ? 1 : 0)),
  };
}

function reduce(c: CompiledRules, w: ArrayLike<number>, start: number, end: number, min: boolean): number {
  if (end <= start) return 0;
  let acc = min ? Infinity : 0;
  for (let k = start; k < end; k++) {
    const v = w[c.idx[k]];
    acc = min ? (v < acc ? v : acc) : acc + v;
  }
  return min ? acc : acc / (end - start);
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

export function smoothstep(lo: number, hi: number, x: number): number {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

/**
 * Evaluates compiled rules on ARKit-ordered weights. out[r] is the weight for
 * c.presets[r]. Visemes are scaled together so their sum is at most 1.
 */
export function evaluatePresets(c: CompiledRules, arkit: ArrayLike<number>, out: Float32Array): Float32Array {
  const n = c.presets.length;
  let visemeSum = 0;
  for (let r = 0; r < n; r++) {
    let v = c.bias[r];
    for (let t = c.termRange[2 * r]; t < c.termRange[2 * r + 1]; t++) {
      v += c.termW[t] * reduce(c, arkit, c.termIdx[2 * t], c.termIdx[2 * t + 1], c.termKind[t] === 1);
    }
    for (let g = c.gateRange[2 * r]; g < c.gateRange[2 * r + 1]; g++) {
      v *= smoothstep(c.gateLo[g], c.gateHi[g], reduce(c, arkit, c.gateIdx[2 * g], c.gateIdx[2 * g + 1], false));
    }
    out[r] = clamp01(v);
    if (c.visemeMask[r]) visemeSum += out[r];
  }
  if (visemeSum > 1) for (let r = 0; r < n; r++) if (c.visemeMask[r]) out[r] /= visemeSum;
  return out;
}

/** Convenience (allocating) wrapper for tests and tools: ARKit record -> { preset: weight }. */
export function presetWeights(arkit: Partial<Record<ArkitName, number>>, rules: readonly PresetRule[] = PRESET_RULES): Record<DrivenPreset, number> {
  const c = compileRules(rules);
  const w = new Float32Array(N_ARKIT);
  ARKIT_BLENDSHAPES.forEach((n, i) => (w[i] = arkit[n] ?? 0));
  const out = evaluatePresets(c, w, new Float32Array(c.presets.length));
  return Object.fromEntries(c.presets.map((p, i) => [p, out[i]])) as Record<DrivenPreset, number>;
}

// --- perfect sync -----------------------------------------------------------------

/**
 * Canonical form for matching expression names: lower case, a trailing
 * "Left"/"_L"/".L"/"-L"/" L" (any case) becomes "left" (same for right), and
 * separators are dropped. "eyeBlinkLeft", "EyeBlink_L" and "eye_blink.l" all
 * become "eyeblinkleft".
 */
export function canonicalExpressionName(name: string): string {
  let s = name.trim().toLowerCase();
  s = s.replace(/(?:[_.\-\s]l|left)$/, "left").replace(/(?:[_.\-\s]r|right)$/, "right");
  return s.replace(/[_.\-\s]/g, "");
}

export interface PerfectSyncMatch {
  /** names[i] = the model's expression name driven by ARKIT_BLENDSHAPES[i], or null. */
  names: (string | null)[];
  count: number;
}

/** Matches the model's expression names to the 52 ARKit names. Exact (case-insensitive) matches win over suffix-normalised ones. */
export function matchPerfectSync(expressionNames: readonly string[]): PerfectSyncMatch {
  const exact = new Map<string, string>();
  const canon = new Map<string, string>();
  for (const n of expressionNames) {
    if (!exact.has(n.toLowerCase())) exact.set(n.toLowerCase(), n);
    const c = canonicalExpressionName(n);
    if (!canon.has(c)) canon.set(c, n);
  }
  const names = ARKIT_BLENDSHAPES.map((a) => exact.get(a.toLowerCase()) ?? canon.get(canonicalExpressionName(a)) ?? null);
  return { names, count: names.filter((n) => n !== null).length };
}

/** A model counts as perfect-sync once at least this many of the 52 ARKit names match. */
export const PERFECT_SYNC_MIN_MATCHES = 26;

// --- eyes ---------------------------------------------------------------------------

const I = Object.fromEntries(ARKIT_BLENDSHAPES.map((n, i) => [n, i])) as Record<ArkitName, number>;

/** Degrees of gaze at eyeLook* = 1 (MediaPipe rarely exceeds ~0.7). */
export const GAZE_YAW_DEG = 30;
export const GAZE_PITCH_DEG = 25;

/**
 * VRM lookAt angles in three-vrm's convention: yaw > 0 looks towards the
 * avatar's left, pitch < 0 looks up. Pass mirrored weights for a mirrored avatar.
 */
export function gazeYawPitch(w: ArrayLike<number>, out: Float32Array | number[]): Float32Array | number[] {
  const toLeft = (w[I.eyeLookOutLeft] + w[I.eyeLookInRight] - w[I.eyeLookInLeft] - w[I.eyeLookOutRight]) * 0.5;
  const up = (w[I.eyeLookUpLeft] + w[I.eyeLookUpRight] - w[I.eyeLookDownLeft] - w[I.eyeLookDownRight]) * 0.5;
  out[0] = toLeft * GAZE_YAW_DEG;
  out[1] = -up * GAZE_PITCH_DEG;
  return out;
}

export const EYE_LOOK_INDICES: readonly number[] = ARKIT_BLENDSHAPES.flatMap((n, i) => (n.startsWith("eyeLook") ? [i] : []));

// --- rotations ----------------------------------------------------------------------

/**
 * Camera-frame head quaternion [x, y, z, w] -> VRM humanoid (normalized bone)
 * frame. The LikenessFrame camera frame (x = subject's left, y up, z towards
 * the camera, face looking +z) is exactly the VRM 1.0 model frame, so VRM 1.0
 * needs nothing. VRM 0.x models face -z (three-vrm's rotateVRM0 turns the scene
 * 180° about y), so their bone-local rotations are conjugated by that turn:
 * (x, y, z, w) -> (-x, y, -z, w).
 * Mirroring reflects across the x = 0 plane: (x, y, z, w) -> (x, -y, -z, w).
 */
export function cameraToVrmQuat(q: ArrayLike<number>, mirror: boolean, vrm0: boolean, out: Float32Array | number[]): Float32Array | number[] {
  let x = q[0], y = q[1], z = q[2], w = q[3];
  const len = Math.hypot(x, y, z, w);
  // Zero or non-finite input -> identity (NaN bone rotations would also poison the spring bones).
  if (!(len > 1e-9) || !Number.isFinite(len)) { x = 0; y = 0; z = 0; w = 1; }
  else { x /= len; y /= len; z /= len; w /= len; }
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  if (mirror) { y = -y; z = -z; }
  if (vrm0) { x = -x; z = -z; }
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
  return out;
}

/** Shortest-path partial rotation: q^t for t in [0, 1] (q normalised, w >= 0). */
export function quatPow(q: ArrayLike<number>, t: number, out: Float32Array | number[]): Float32Array | number[] {
  const w = Math.min(1, Math.max(-1, q[3]));
  const half = Math.acos(w);
  const s = Math.sin(half);
  if (s < 1e-6) { out[0] = q[0] * t; out[1] = q[1] * t; out[2] = q[2] * t; out[3] = 1; return out; }
  const k = Math.sin(half * t) / s;
  out[0] = q[0] * k; out[1] = q[1] * k; out[2] = q[2] * k; out[3] = Math.cos(half * t);
  return out;
}

/** Fraction of the head rotation given to the neck bone (the head bone gets the rest). */
export const NECK_SHARE = 0.3;
