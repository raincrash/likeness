/** Retargeting MediaPipe hand landmarks onto the WebXR generic-hand skeleton (rendering only, uses three.js). */
import * as THREE from "three";
import { BONES, LANDMARK_JOINT, N_JOINTS, N_LANDMARKS, palmSize } from "./handMath.js";

// --- retargeting onto the XR joints -------------------------------------------------------

/** The model's rest pose: joint positions and rotations in armature space, plus derived frames. */
export interface HandRest {
  pos: Float32Array; // 25*3
  quat: Float32Array; // 25*4 (x, y, z, w)
  /** Mean wrist -> index/middle/ring/pinky proximal length, comparable with palmSize() of landmarks. */
  size: number;
  /** Rest bone frames F0 (column-major 3x3 per joint), see boneFrame(). */
  frames: Float32Array; // 25*9
}

const _d = new THREE.Vector3(), _r = new THREE.Vector3(), _e2 = new THREE.Vector3(), _e3 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q0 = new THREE.Quaternion(), _v = new THREE.Vector3();

/**
 * Orthonormal frame [d, r', d x r'] from a bone direction d and a twist reference r (r is
 * orthogonalised against d; if it is nearly parallel, `alt` is used). Stored column-major in out[o..o+9].
 */
export function boneFrame(d: THREE.Vector3, r: THREE.Vector3, alt: THREE.Vector3, out: Float32Array, o: number): void {
  _d.copy(d).normalize();
  _e2.copy(r).addScaledVector(_d, -r.dot(_d));
  if (_e2.lengthSq() < 1e-6 * Math.max(r.lengthSq(), 1e-12)) _e2.copy(alt).addScaledVector(_d, -alt.dot(_d));
  _e2.normalize();
  _e3.crossVectors(_d, _e2);
  out[o] = _d.x; out[o + 1] = _d.y; out[o + 2] = _d.z;
  out[o + 3] = _e2.x; out[o + 4] = _e2.y; out[o + 5] = _e2.z;
  out[o + 6] = _e3.x; out[o + 7] = _e3.y; out[o + 8] = _e3.z;
}

/** Reference vectors of a hand given point accessor `at(landmark, out)`. */
function palmRefs(at: (lm: number, out: THREE.Vector3) => THREE.Vector3, lateral: THREE.Vector3, normal: THREE.Vector3) {
  const w = at(0, new THREE.Vector3()), i = at(5, new THREE.Vector3()), p = at(17, new THREE.Vector3());
  const m = at(9, new THREE.Vector3()).sub(w);
  normal.crossVectors(i.sub(w), p.sub(w));
  // In the palm plane, across the palm's long axis (wrist -> middle MCP), towards the index side.
  lateral.crossVectors(m, normal);
}

function frameOf(at: (lm: number, out: THREE.Vector3) => THREE.Vector3, out: Float32Array) {
  const lateral = new THREE.Vector3(), normal = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  palmRefs(at, lateral, normal);
  BONES.forEach((bone, j) => {
    const d = at(bone.to, a).sub(at(bone.from, b));
    const [r, alt] = bone.ref === "lateral" ? [lateral, normal] : [normal, lateral];
    boneFrame(d, r, alt, out, j * 9);
  });
}

/**
 * Builds the rest description from the model's joints (armature-space positions and rotations).
 * The model is matched to landmarks through LANDMARK_JOINT, so any bone-axis convention works:
 * a bone's live rotation is (live frame) * (rest frame)^T * (rest rotation).
 */
export function makeRest(pos: Float32Array, quat: Float32Array): HandRest {
  const at = (lm: number, out: THREE.Vector3) => out.fromArray(pos, LANDMARK_JOINT[lm] * 3);
  const frames = new Float32Array(N_JOINTS * 9);
  frameOf(at, frames);
  const lmPos = new Float32Array(N_LANDMARKS * 3);
  for (let l = 0; l < N_LANDMARKS; l++) for (let k = 0; k < 3; k++) lmPos[l * 3 + k] = pos[LANDMARK_JOINT[l] * 3 + k];
  return { pos, quat, frames, size: palmSize(lmPos) };
}

const _live = new Float32Array(N_JOINTS * 9);
const _delta = Array.from({ length: N_JOINTS }, () => new THREE.Quaternion());

/**
 * Poses the model from 21 landmarks (any right-handed frame with the same chirality convention as
 * the model's armature space, e.g. scene coordinates). Writes joint positions relative to landmark 0
 * (the wrist) in the landmarks' units and joint rotations in that frame. Bones keep the model's
 * proportions scaled by the returned factor (landmark palm size / model palm size): positions are
 * forward kinematics from the wrist, so the mesh never stretches.
 */
export function solvePose(rest: HandRest, lm: ArrayLike<number>, outPos: Float32Array, outQuat: Float32Array): number {
  const at = (l: number, out: THREE.Vector3) => out.set(lm[l * 3], lm[l * 3 + 1], lm[l * 3 + 2]);
  frameOf(at, _live);
  const k = palmSize(lm) / rest.size;
  for (let j = 0; j < N_JOINTS; j++) {
    // delta = F * F0^T maps the rest bone frame onto the live one.
    const F = _live, F0 = rest.frames, o = j * 9;
    const m = (r: number, c: number) => F[o + r] * F0[o + c] + F[o + 3 + r] * F0[o + 3 + c] + F[o + 6 + r] * F0[o + 6 + c];
    _m.set(m(0, 0), m(0, 1), m(0, 2), 0, m(1, 0), m(1, 1), m(1, 2), 0, m(2, 0), m(2, 1), m(2, 2), 0, 0, 0, 0, 1);
    const delta = _delta[j].setFromRotationMatrix(_m);
    _q0.fromArray(rest.quat, j * 4);
    _q.multiplyQuaternions(delta, _q0).normalize();
    _q.toArray(outQuat, j * 4);

    const p = BONES[j].parent;
    if (p < 0) { outPos[0] = outPos[1] = outPos[2] = 0; continue; }
    _v.fromArray(rest.pos, j * 3).sub(_r.fromArray(rest.pos, p * 3)).applyQuaternion(_delta[p]).multiplyScalar(k);
    for (let c = 0; c < 3; c++) outPos[j * 3 + c] = outPos[p * 3 + c] + _v.getComponent(c);
  }
  return k;
}
