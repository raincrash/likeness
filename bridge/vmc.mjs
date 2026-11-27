// LikenessFrame -> VMC protocol (performer -> marionette) messages. Pure functions, no I/O.
//
// Coordinate conventions (see bridge/README.md for the derivation):
//   likeness frame : right-handed, metres, x = subject's left (camera image right), y up,
//                    z from the subject towards the camera. Not mirrored.
//   VMC / Unity    : left-handed, metres, y up, the avatar faces +z, so +x is the avatar's right.
//                    Bone rotations are local, relative to the parent, and identity is the VRM
//                    (normalised, VRM 0.x) T-pose. Root is the avatar's root transform.
//
// Unmirrored (default): the avatar does what the subject does with the same body part.
//   point (x, y, z)        -> (-x, y, z)           reflection, so right-handed -> left-handed
//   quaternion (x, y, z, w) -> (x, -y, -z, w)       the same reflection applied to a rotation
//   subject left hand -> LeftHand, eyeBlinkLeft -> eyeBlinkLeft
// Mirrored (--mirror): the avatar behaves like your reflection, as most VTuber apps do by default.
//   That adds a second reflection across the avatar's x, which cancels the first:
//   point (x, y, z) -> (x, y, z), quaternion unchanged, Left <-> Right swapped everywhere.

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
];

/** VRM 0.x preset BlendShapeClip names, in the order they are sent. */
export const VRM_PRESETS = [
  "Neutral", "A", "I", "U", "E", "O", "Blink", "Blink_L", "Blink_R",
  "Joy", "Angry", "Sorrow", "Fun", "LookUp", "LookDown", "LookLeft", "LookRight",
];

export const DEFAULT_OPTIONS = {
  mirror: false,
  /** "pascal" (JawOpen, the VRM 0.x perfect-sync clip names), "camel" (jawOpen, ARKit/MediaPipe) or "both". */
  blendCase: "pascal",
  /** Which blendshapes to send: "all", "arkit" (perfect sync only) or "vrm" (presets only). */
  blendshapes: "all",
  /** Send Joy/Angry/Sorrow/Fun (part of "vrm"). */
  emotions: true,
  hands: true,
  /** Share of the head rotation given to the Neck bone; the Head bone gets the rest. */
  neckShare: 0.3,
  /** Move the Root with the head position (relative to the first position seen). Off: Root stays at the origin. */
  rootMotion: false,
};

// ---------------------------------------------------------------- validation

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Checks and normalises an untrusted, already-parsed LikenessFrame. Returns a clean copy (missing
 * blendshapes = 0, values clamped to 0..1, quaternion normalised) or throws an Error saying why.
 */
export function validateFrame(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("frame is not an object");
  if (f.v !== 1) throw new Error(`unsupported frame version ${JSON.stringify(f.v)}`);
  if (!finite(f.t)) throw new Error("t must be a finite number");
  let face = null;
  if (f.face != null) {
    const fc = f.face;
    if (typeof fc !== "object" || !fc.blendshapes || typeof fc.blendshapes !== "object") throw new Error("face.blendshapes missing");
    const blendshapes = {};
    for (const n of ARKIT_BLENDSHAPES) {
      const v = fc.blendshapes[n];
      blendshapes[n] = finite(v) ? clamp01(v) : 0;
    }
    const r = fc.head && fc.head.rotation;
    const p = fc.head && fc.head.position;
    if (!Array.isArray(r) || r.length !== 4 || !r.every(finite)) throw new Error("face.head.rotation must be 4 finite numbers");
    if (!Array.isArray(p) || p.length !== 3 || !p.every(finite)) throw new Error("face.head.position must be 3 finite numbers");
    const len = Math.hypot(r[0], r[1], r[2], r[3]);
    if (len < 1e-6) throw new Error("face.head.rotation is a zero quaternion");
    face = {
      blendshapes,
      head: { rotation: r.map((x) => x / len), position: p.slice() },
      calibrated: fc.calibrated === true,
    };
  }
  if (!Array.isArray(f.hands)) throw new Error("hands must be an array");
  if (f.hands.length > 4) throw new Error("too many hands");
  const hands = f.hands.map((h, i) => {
    if (!h || (h.side !== "left" && h.side !== "right")) throw new Error(`hands[${i}].side must be "left" or "right"`);
    if (!Array.isArray(h.joints) || h.joints.length !== 21) throw new Error(`hands[${i}].joints must have 21 joints`);
    const joints = h.joints.map((j) => {
      if (!Array.isArray(j) || j.length !== 3 || !j.every(finite)) throw new Error(`hands[${i}] has a bad joint`);
      return [j[0], j[1], j[2]];
    });
    return { side: h.side, score: finite(h.score) ? h.score : 1, joints };
  });
  return { v: 1, t: f.t, face, hands };
}

// ---------------------------------------------------------------- maths

/** Quaternion product a*b, [x, y, z, w]. */
export function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];

/** q^t: the same axis, t times the angle (shortest arc). */
export function qpow(q, t) {
  let [x, y, z, w] = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [0, 0, 0, 1];
  const half = Math.atan2(s, w) * t;
  const k = Math.sin(half) / s;
  return [x * k, y * k, z * k, Math.cos(half)];
}

function qrotate(q, v) {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
}

/** Rotation matrix (rows) -> quaternion. */
function qFromMat(m) {
  const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = m;
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return q.map((x) => x / n);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < 1e-12 ? null : scale(a, 1 / l);
}

/** Smallest rotation taking unit vector a onto unit vector b. */
function swing(a, b) {
  const d = dot(a, b);
  if (d < -0.999999) {
    const axis = norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(a, b);
  const q = [c[0], c[1], c[2], 1 + d];
  const n = Math.hypot(...q);
  return q.map((x) => x / n);
}

/** likeness camera frame -> VMC/Unity space (see the header). */
export function convertPoint(p, mirror) {
  return mirror ? [p[0], p[1], p[2]] : [-p[0], p[1], p[2]];
}
export function convertRotation(q, mirror) {
  return mirror ? [q[0], q[1], q[2], q[3]] : [q[0], -q[1], -q[2], q[3]];
}

// ---------------------------------------------------------------- blendshapes

const swapLR = (n) => (n.endsWith("Left") ? n.slice(0, -4) + "Right" : n.endsWith("Right") ? n.slice(0, -5) + "Left" : n);

/** ARKit weights as the avatar should show them (Left/Right swapped when mirrored). */
export function avatarArkit(blendshapes, mirror) {
  if (!mirror) return { ...blendshapes };
  const out = {};
  for (const n of ARKIT_BLENDSHAPES) out[swapLR(n)] = blendshapes[n];
  return out;
}

/** "jawOpen" -> "JawOpen". */
export const pascal = (n) => n[0].toUpperCase() + n.slice(1);

/** ramp(v, lo, hi): 0 below lo, 1 above hi, linear in between. */
const ramp = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

/**
 * VRM 0.x presets derived from (already mirrored) ARKit weights. Heuristic; see the table in
 * bridge/README.md. Blink is the part both eyes share, Blink_L/R the remainder, so a model whose
 * Blink clip closes both eyes is never driven past 1.
 */
export function vrmPresets(a, emotions = true) {
  const avg = (l, r) => (a[l] + a[r]) / 2;
  const jaw = a.jawOpen;
  const smile = avg("mouthSmileLeft", "mouthSmileRight");
  const stretch = avg("mouthStretchLeft", "mouthStretchRight");
  const lower = avg("mouthLowerDownLeft", "mouthLowerDownRight");
  const frown = avg("mouthFrownLeft", "mouthFrownRight");
  const browDown = avg("browDownLeft", "browDownRight");
  const sneer = avg("noseSneerLeft", "noseSneerRight");
  const round = Math.max(a.mouthFunnel, a.mouthPucker);

  // Visemes. Rounded lips pick O (open) or U (closed); spread lips pick I (closed) or E (open); else A.
  const open = ramp(jaw, 0.05, 0.35);
  const spread = clamp01(1.5 * stretch + 0.5 * smile);
  let O = clamp01(1.5 * a.mouthFunnel) * open;
  let U = clamp01(1.5 * a.mouthPucker) * (1 - open);
  let I = spread * (1 - open) * (1 - round);
  let E = clamp01(spread + lower) * open * (1 - round) * 0.8;
  let A = clamp01(1.5 * jaw) * (1 - round) * (1 - 0.5 * spread);
  const total = A + I + U + E + O;
  if (total > 1) { A /= total; I /= total; U /= total; E /= total; O /= total; }

  const blink = Math.min(a.eyeBlinkLeft, a.eyeBlinkRight);
  const p = {
    Neutral: 0, A, I, U, E, O,
    Blink: blink, Blink_L: a.eyeBlinkLeft - blink, Blink_R: a.eyeBlinkRight - blink,
    Joy: 0, Angry: 0, Sorrow: 0, Fun: 0,
    LookUp: avg("eyeLookUpLeft", "eyeLookUpRight"),
    LookDown: avg("eyeLookDownLeft", "eyeLookDownRight"),
    // The avatar looks to its own left: its left eye turns out, its right eye turns in.
    LookLeft: avg("eyeLookOutLeft", "eyeLookInRight"),
    LookRight: avg("eyeLookInLeft", "eyeLookOutRight"),
  };
  if (emotions) {
    p.Joy = ramp(smile, 0.45, 0.85);
    p.Fun = ramp(smile, 0.15, 0.45) * (1 - p.Joy);
    p.Angry = ramp(0.7 * browDown + 0.3 * sneer, 0.3, 0.7) * (1 - p.Joy);
    p.Sorrow = ramp(0.4 * a.browInnerUp + 0.6 * frown, 0.25, 0.6) * (1 - p.Joy) * (1 - p.Angry);
  }
  for (const k of Object.keys(p)) p[k] = clamp01(p[k]);
  return p;
}

// ---------------------------------------------------------------- hands

export const FINGERS = [
  // VRM/Unity finger name, MediaPipe joints [base, next, next, tip]
  ["Thumb", [1, 2, 3, 4]],
  ["Index", [5, 6, 7, 8]],
  ["Middle", [9, 10, 11, 12]],
  ["Ring", [13, 14, 15, 16]],
  ["Little", [17, 18, 19, 20]],
];
const SEGMENTS = ["Proximal", "Intermediate", "Distal"];

// Typical adult bone offsets (metres, Unity local space, LEFT side; the right side negates x).
// Receivers that apply bone positions (EVMC4U by default) use these; most use rotations only.
const BONE_POS = {
  Neck: [0, 0.1, 0], Head: [0, 0.08, 0], Hand: [-0.22, 0, 0],
  ThumbProximal: [-0.02, -0.008, 0.02], ThumbIntermediate: [-0.021, 0, 0.021], ThumbDistal: [-0.02, 0, 0.02],
  IndexProximal: [-0.075, 0.003, 0.022], IndexIntermediate: [-0.04, 0, 0], IndexDistal: [-0.023, 0, 0],
  MiddleProximal: [-0.078, 0.003, 0.004], MiddleIntermediate: [-0.045, 0, 0], MiddleDistal: [-0.026, 0, 0],
  RingProximal: [-0.073, 0.002, -0.012], RingIntermediate: [-0.042, 0, 0], RingDistal: [-0.025, 0, 0],
  LittleProximal: [-0.065, 0, -0.026], LittleIntermediate: [-0.032, 0, 0], LittleDistal: [-0.02, 0, 0],
};
const bonePos = (key, side) => {
  const p = BONE_POS[key];
  return side === "Left" ? p.slice() : [-p[0], p[1], p[2]];
};

/** Hand basis [fingers, thumb side, cross] as matrix columns; same construction for rest and tracked hands. */
function handBasis(wrist, middleMcp, indexMcp, pinkyMcp) {
  const f = norm(sub(middleMcp, wrist));
  const a = norm(sub(indexMcp, pinkyMcp));
  if (!f || !a) return null;
  const s = norm(sub(a, scale(f, dot(a, f))));
  if (!s) return null;
  return [f, s, cross(f, s)];
}
const restFinger = (side) => (side === "Left" ? [-1, 0, 0] : [1, 0, 0]);
/** VRM T-pose: palm down, fingers along the arm, thumb forward (+z). */
const restBasis = (side) => {
  const f = restFinger(side);
  return [f, [0, 0, 1], cross(f, [0, 0, 1])];
};
const restThumb = (side) => norm([restFinger(side)[0], 0, 1]);

/** Rotation taking basis A to basis B (both as column triples). */
function basisRotation(B, A) {
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) m[r][c] += B[k][r] * A[k][c];
  return qFromMat(m);
}

/**
 * Local bone rotations for one hand, already in VMC space. `side` is the avatar side ("Left"/"Right").
 * Returns [{ name, pos, rot }] for <side>Hand and the 15 finger bones, or rest poses when joints is null.
 */
export function handBones(joints, side) {
  const out = [];
  const add = (name, key, rot) => out.push({ name: side + name, pos: bonePos(key, side), rot });
  if (!joints) {
    add("Hand", "Hand", [0, 0, 0, 1]);
    for (const [finger] of FINGERS) for (const seg of SEGMENTS) add(finger + seg, finger + seg, [0, 0, 0, 1]);
    return out;
  }
  const basis = handBasis(joints[0], joints[9], joints[5], joints[17]);
  if (!basis) return handBones(null, side);
  const hand = basisRotation(basis, restBasis(side));
  add("Hand", "Hand", hand);
  const toHand = qconj(hand);
  for (const [finger, idx] of FINGERS) {
    const rest = finger === "Thumb" ? restThumb(side) : restFinger(side);
    let global = [0, 0, 0, 1]; // accumulated rotation of the chain, in hand space
    for (let k = 0; k < 3; k++) {
      const d = norm(sub(joints[idx[k + 1]], joints[idx[k]]));
      let local = [0, 0, 0, 1];
      if (d) {
        const inParent = qrotate(qconj(global), qrotate(toHand, d));
        local = swing(rest, inParent);
      }
      global = qmul(global, local);
      add(finger + SEGMENTS[k], finger + SEGMENTS[k], local);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the message set

/**
 * Builds the VMC message list for one frame: [{ address, args }] where args are strings, plain
 * numbers (float32) or { type: "i", value } ints. `state` carries the root-motion reference between
 * calls ({} to start).
 */
export function frameToVmc(frame, opts = {}, state = {}, timeSeconds = 0) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const msgs = [];
  const m = (address, ...args) => msgs.push({ address, args });
  const i = (value) => ({ type: "i", value });
  const face = frame.face;

  // /VMC/Ext/OK loaded=1, calibration state=3 (calibrated), mode=0 (normal), tracking status (V2.7).
  m("/VMC/Ext/OK", i(1), i(3), i(0), i(face ? 1 : 0));
  m("/VMC/Ext/T", timeSeconds);

  let rootPos = [0, 0, 0];
  if (o.rootMotion && face) {
    if (!state.rootRef) state.rootRef = face.head.position.slice();
    rootPos = convertPoint(sub(face.head.position, state.rootRef), o.mirror);
  }
  m("/VMC/Ext/Root/Pos", "root", ...rootPos, 0, 0, 0, 1);

  if (face) {
    const q = convertRotation(face.head.rotation, o.mirror);
    const neck = qpow(q, o.neckShare);
    const head = qpow(q, 1 - o.neckShare);
    m("/VMC/Ext/Bone/Pos", "Neck", ...BONE_POS.Neck, ...neck);
    m("/VMC/Ext/Bone/Pos", "Head", ...BONE_POS.Head, ...head);
  }

  if (o.hands) {
    for (const side of ["Left", "Right"]) {
      // Avatar side -> tracked side: same side unmirrored, the opposite side mirrored.
      const want = (side === "Left") !== o.mirror ? "left" : "right";
      const tracked = frame.hands.filter((h) => h.side === want).sort((a, b) => b.score - a.score)[0];
      const joints = tracked ? tracked.joints.map((p) => convertPoint(p, o.mirror)) : null;
      for (const b of handBones(joints, side)) m("/VMC/Ext/Bone/Pos", b.name, ...b.pos, ...b.rot);
    }
  }

  if (face) {
    const a = avatarArkit(face.blendshapes, o.mirror);
    if (o.blendshapes !== "arkit") {
      const p = vrmPresets(a, o.emotions);
      for (const n of VRM_PRESETS) m("/VMC/Ext/Blend/Val", n, p[n]);
    }
    if (o.blendshapes !== "vrm") {
      for (const n of ARKIT_BLENDSHAPES) {
        if (o.blendCase !== "camel") m("/VMC/Ext/Blend/Val", pascal(n), a[n]);
        if (o.blendCase !== "pascal") m("/VMC/Ext/Blend/Val", n, a[n]);
      }
    }
    m("/VMC/Ext/Blend/Apply");
  }
  return msgs;
}
