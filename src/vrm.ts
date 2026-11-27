/**
 * Bring-your-own-avatar: loads a VRM (0.x or 1.0) with @pixiv/three-vrm and
 * drives it from LikenessFrames (expressions, head/neck, eyes, fingers, arms).
 *
 * Frames: the LikenessFrame camera frame (x = subject's left, y up, z towards
 * the camera) is exactly the VRM 1.0 model frame, and VRM 0.x models are
 * turned to match with VRMUtils.rotateVRM0. `scene` is a wrapper group whose
 * local frame is therefore "the camera frame, scaled to the avatar". Place,
 * rotate or scale the wrapper freely; all bone solving happens in world space.
 *
 * The pure mapping (ARKit -> VRM presets, perfect sync, mirroring, gaze) lives
 * in vrmMapping.ts. See docs/vrm.md.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import type { HandOutput, LikenessFrame } from "./frame.js";
import {
  N_ARKIT, PERFECT_SYNC_MIN_MATCHES, EYE_LOOK_INDICES, NECK_SHARE,
  compileRules, evaluatePresets, readBlendshapes, matchPerfectSync, gazeYawPitch, cameraToVrmQuat, quatPow,
  type CompiledRules,
} from "./vrmMapping.js";

export interface VrmMeta {
  title: string;
  author: string;
  /** VRM 1.0: licence URL. VRM 0.x: licence name (or its URL for "Other"). */
  license: string;
  /** VRM spec version of the file: "1.0" or "0.x". */
  version: "1.0" | "0.x";
  /** The model's own version string, if any. */
  modelVersion: string;
}

export interface VrmApplyOptions {
  /** Mirror the avatar (selfie view): swaps left/right expressions and hands, reflects rotations. */
  mirror?: boolean;
  /** Drive emotion presets (happy/angry/sad/surprised) in preset mode. Default true. */
  emotions?: boolean;
  /** Two-bone arm IK placing the wrists at the tracked hands. Default true. Fingers are driven either way. */
  arms?: boolean;
}

/** Typical adult shoulder-to-wrist length (m), used to scale tracked hand offsets to the avatar. */
const HUMAN_ARM_LENGTH = 0.55;
/** Tracked head centre sits about this far (m, human scale) above the VRM head bone. */
const HEAD_CENTRE_ABOVE_HEAD_BONE = 0.08;
/** Seconds for arms to blend in/out when a hand appears/disappears. */
const HAND_FADE_S = 0.25;

// MediaPipe joint indices.
const WRIST = 0, INDEX_MCP = 5, MIDDLE_MCP = 9, PINKY_MCP = 17;

/** [VRM bone suffix, from joint, to joint]. VRM 0.x thumbs are renamed to these by three-vrm. */
const FINGER_BONES: readonly [string, number, number][] = [
  ["ThumbMetacarpal", 1, 2], ["ThumbProximal", 2, 3], ["ThumbDistal", 3, 4],
  ["IndexProximal", 5, 6], ["IndexIntermediate", 6, 7], ["IndexDistal", 7, 8],
  ["MiddleProximal", 9, 10], ["MiddleIntermediate", 10, 11], ["MiddleDistal", 11, 12],
  ["RingProximal", 13, 14], ["RingIntermediate", 14, 15], ["RingDistal", 15, 16],
  ["LittleProximal", 17, 18], ["LittleIntermediate", 18, 19], ["LittleDistal", 19, 20],
];

interface FingerBone {
  node: THREE.Object3D;
  /** Rest direction towards the next joint, in the bone's own (normalized, identity-rest) frame. */
  dir: THREE.Vector3;
  from: number;
  to: number;
  relaxed: THREE.Quaternion;
}

interface ArmRig {
  /** +1 for the avatar's left (+x in the camera/VRM 1.0 frame), -1 for its right. */
  sign: number;
  upper: THREE.Object3D | null;
  lower: THREE.Object3D | null;
  hand: THREE.Object3D | null;
  upperDir: THREE.Vector3;
  lowerDir: THREE.Vector3;
  /** Rest hand world orientation and palm basis, in the wrapper frame at load time. */
  handRestQ: THREE.Quaternion;
  restBasisT: THREE.Matrix4;
  hasBasis: boolean;
  fingers: FingerBone[];
  relaxed: [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion];
  /** Last tracked joints (camera frame, already mirrored if needed). */
  joints: Float32Array;
  seen: boolean;
  weight: number;
}

// Scratch (module-level so apply() never allocates).
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _S = new THREE.Vector3(), _E = new THREE.Vector3(), _T = new THREE.Vector3(), _P = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _qWrap = new THREE.Quaternion(), _qCorr = new THREE.Quaternion(), _qInv = new THREE.Quaternion();
const _C = new THREE.Vector3(), _L = new THREE.Vector3();
const _m0 = new THREE.Matrix4();
const _quat4 = new Float32Array(4), _part4 = new Float32Array(4);

export class VrmAvatar {
  /** Add this to your scene. Its local frame = LikenessFrame camera frame; the avatar's feet are at its origin. */
  readonly scene: THREE.Group;
  readonly vrm: VRM;
  readonly meta: VrmMeta;
  /** True when the model has ARKit perfect-sync expressions and they are driven directly. */
  readonly perfectSync: boolean;

  private readonly isVrm0: boolean;
  private readonly rules: CompiledRules;
  private readonly ruleExpr: (string | null)[];
  private readonly psExpr: (string | null)[];
  private readonly gazeFromBlendshapes: boolean;
  private readonly arkit = new Float32Array(N_ARKIT);
  private readonly presetOut: Float32Array;
  private readonly gaze = new Float32Array(2);
  private readonly neck: THREE.Object3D | null;
  private readonly head: THREE.Object3D | null;
  /** Upper torso bone, used to keep the hands clear of the body. */
  private readonly chest: THREE.Object3D | null;
  private readonly arms: [ArmRig, ArmRig];
  private readonly headPos = new THREE.Vector3(0, 0, -0.6);

  /** Loads a .vrm from a URL, a File (e.g. from <input type=file>) or an ArrayBuffer. */
  static async load(source: string | File | ArrayBuffer): Promise<VrmAvatar> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = typeof source === "string"
      ? await loader.loadAsync(source)
      : await loader.parseAsync(source instanceof ArrayBuffer ? source : await source.arrayBuffer(), "");
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      VRMUtils.deepDispose(gltf.scene);
      throw new Error("Not a VRM file: no VRMC_vrm (1.0) or VRM (0.x) extension found.");
    }
    return VrmAvatar.fromVrm(vrm);
  }

  /**
   * Wraps a VRM you loaded yourself (GLTFLoader + VRMLoaderPlugin, gltf.userData.vrm).
   * Optimises it in place and turns VRM 0.x to face +z, so don't call VRMUtils.rotateVRM0 yourself.
   */
  static fromVrm(vrm: VRM): VrmAvatar {
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.combineMorphs(vrm);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -z; turn it to face +z like VRM 1.0
    // Skinned meshes' bounds don't follow the pose; avoid popping out at the screen edge.
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    return new VrmAvatar(vrm);
  }

  private constructor(vrm: VRM) {
    this.vrm = vrm;
    this.scene = new THREE.Group();
    this.scene.name = "VrmAvatar";
    this.scene.add(vrm.scene);

    const m = vrm.meta;
    this.isVrm0 = m.metaVersion === "0";
    this.meta = m.metaVersion === "1"
      ? { title: m.name ?? "", author: (m.authors ?? []).join(", "), license: m.licenseUrl ?? "", version: "1.0", modelVersion: m.version ?? "" }
      : {
          title: m.title ?? "", author: m.author ?? "", version: "0.x", modelVersion: m.version ?? "",
          license: m.licenseName === "Other" ? (m.otherLicenseUrl ?? "Other") : (m.licenseName ?? ""),
        };

    // Expressions: perfect sync if enough ARKit names match, otherwise the preset table.
    const em = vrm.expressionManager;
    const ps = matchPerfectSync(em ? Object.keys(em.customExpressionMap) : []);
    this.perfectSync = ps.count >= PERFECT_SYNC_MIN_MATCHES;
    this.psExpr = this.perfectSync ? ps.names : [];
    this.rules = compileRules();
    this.presetOut = new Float32Array(this.rules.presets.length);
    this.ruleExpr = this.rules.presets.map((p) => (em?.getExpression(p) ? p : null));
    this.gazeFromBlendshapes = this.perfectSync && EYE_LOOK_INDICES.some((i) => ps.names[i] !== null);

    // Bones (normalized rig: identity local rotations at rest).
    const h = vrm.humanoid;
    const bone = (name: string) => h.getNormalizedBoneNode(name as VRMHumanBoneName);
    this.neck = bone("neck");
    this.head = bone("head");
    this.chest = bone("upperChest") ?? bone("chest") ?? bone("spine");
    h.resetNormalizedPose();
    this.scene.updateMatrixWorld(true);
    this.arms = [this.makeArm("left", +1, bone), this.makeArm("right", -1, bone)];
  }

  private makeArm(side: "left" | "right", sign: number, bone: (n: string) => THREE.Object3D | null): ArmRig {
    const upper = bone(`${side}UpperArm`), lower = bone(`${side}LowerArm`), hand = bone(`${side}Hand`);
    const dirTo = (child: THREE.Object3D | null, fallback: THREE.Vector3) =>
      child && child.position.lengthSq() > 0 ? child.position.clone().normalize() : fallback;
    const out = new THREE.Vector3(sign, 0, 0);
    // Rest directions are in each bone's own frame; at rest that frame equals the rig frame,
    // which for VRM 0.x is turned 180° from the wrapper, hence the sign flip on the fallback.
    if (this.isVrm0) out.x = -out.x;
    const fingers: FingerBone[] = [];
    for (let i = 0; i < FINGER_BONES.length; i++) {
      const [suffix, from, to] = FINGER_BONES[i];
      const node = bone(side + suffix);
      if (!node) continue;
      const next = i % 3 < 2 ? bone(side + FINGER_BONES[i + 1][0]) : null;
      // Last bone of a finger: continue the direction it hangs off its parent.
      fingers.push({ node, dir: dirTo(next, dirTo(node, out)), from, to, relaxed: new THREE.Quaternion() });
    }
    const restBasisT = new THREE.Matrix4();
    const handRestQ = new THREE.Quaternion();
    const idx = bone(`${side}IndexProximal`), mid = bone(`${side}MiddleProximal`), lit = bone(`${side}LittleProximal`);
    const hasBasis = !!(hand && idx && mid && lit);
    if (hand && idx && mid && lit) {
      hand.getWorldQuaternion(handRestQ); // wrapper has no parent yet: world = wrapper frame
      const w = hand.getWorldPosition(new THREE.Vector3());
      palmBasis(w, idx.getWorldPosition(new THREE.Vector3()), mid.getWorldPosition(new THREE.Vector3()),
        lit.getWorldPosition(new THREE.Vector3()), restBasisT);
      restBasisT.transpose();
    }
    return {
      sign, upper, lower, hand, fingers, hasBasis, handRestQ, restBasisT,
      upperDir: dirTo(lower, out), lowerDir: dirTo(hand, out),
      relaxed: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()],
      joints: new Float32Array(63), seen: false, weight: 0,
    };
  }

  /** World position of the avatar's head bone (for framing the camera). */
  getHeadPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.head ? this.head.getWorldPosition(out) : this.scene.getWorldPosition(out);
  }

  /** Drives expressions, head, eyes and hands from one frame. Call update(dt) afterwards, once per rendered frame. Allocation-free. */
  apply(frame: LikenessFrame, dt: number, opts?: VrmApplyOptions): void {
    const mirror = !!opts?.mirror;
    const face = frame.face;
    if (face) {
      readBlendshapes(face.blendshapes, this.arkit, mirror);
      this.applyExpressions(opts?.emotions !== false);
      this.applyGaze();
      this.applyHead(face.head.rotation, mirror);
      const p = face.head.position;
      if (Number.isFinite(p[0] + p[1] + p[2])) this.headPos.set(mirror ? -p[0] : p[0], p[1], p[2]);
    }
    this.applyArms(frame.hands, dt, mirror, opts?.arms !== false);
  }

  /** Advances three-vrm: copies normalized bones to the mesh, look-at, expressions, spring bones, constraints. */
  update(dt: number): void {
    this.vrm.update(dt);
  }

  dispose(): void {
    this.scene.removeFromParent();
    VRMUtils.deepDispose(this.vrm.scene);
  }

  // --- expressions -------------------------------------------------------------

  private applyExpressions(emotions: boolean) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    if (this.perfectSync) {
      for (let i = 0; i < N_ARKIT; i++) {
        const name = this.psExpr[i];
        if (name !== null) em.setValue(name, this.arkit[i]);
      }
      return;
    }
    evaluatePresets(this.rules, this.arkit, this.presetOut);
    for (let r = 0; r < this.ruleExpr.length; r++) {
      const name = this.ruleExpr[r];
      if (name === null) continue;
      const emotion = name === "happy" || name === "angry" || name === "sad" || name === "surprised";
      em.setValue(name, emotion && !emotions ? 0 : this.presetOut[r]);
    }
  }

  private applyGaze() {
    const la = this.vrm.lookAt;
    if (!la) return;
    if (this.gazeFromBlendshapes) {
      la.yaw = 0;
      la.pitch = 0;
      return;
    }
    gazeYawPitch(this.arkit, this.gaze); // arkit is already mirrored when needed
    la.yaw = this.gaze[0];
    la.pitch = this.gaze[1];
  }

  // --- head --------------------------------------------------------------------

  private applyHead(rotation: readonly number[], mirror: boolean) {
    if (!this.head) return;
    cameraToVrmQuat(rotation, mirror, this.isVrm0, _quat4);
    if (this.neck) {
      quatPow(_quat4, NECK_SHARE, _part4);
      this.neck.quaternion.set(_part4[0], _part4[1], _part4[2], _part4[3]);
      quatPow(_quat4, 1 - NECK_SHARE, _part4);
      this.head.quaternion.set(_part4[0], _part4[1], _part4[2], _part4[3]);
    } else {
      this.head.quaternion.set(_quat4[0], _quat4[1], _quat4[2], _quat4[3]);
    }
  }

  // --- arms and hands ------------------------------------------------------------

  private applyArms(hands: readonly HandOutput[], dt: number, mirror: boolean, ik: boolean) {
    for (let s = 0; s < 2; s++) {
      const arm = this.arms[s];
      // Avatar's left (s = 0) shows the subject's left hand, or their right one when mirrored.
      const want = (s === 0) !== mirror ? "left" : "right";
      let best: HandOutput | null = null;
      for (let i = 0; i < hands.length; i++) {
        const h = hands[i];
        if (h.side === want && h.joints.length >= 21 && (!best || h.score > best.score)) best = h;
      }
      if (best) {
        for (let j = 0; j < 21; j++) {
          const p = best.joints[j];
          arm.joints[3 * j] = mirror ? -p[0] : p[0];
          arm.joints[3 * j + 1] = p[1];
          arm.joints[3 * j + 2] = p[2];
        }
        arm.seen = true;
      }
      const step = dt > 0 ? Math.min(1, dt / HAND_FADE_S) : 1;
      arm.weight = best ? Math.min(1, arm.weight + step) : Math.max(0, arm.weight - step);
      this.solveArm(arm, ik);
    }
  }

  /**
   * Tracked wrist relative to the head (camera metres, x/y/z in the camera frame), robust to depth
   * error. MediaPipe's hand depth is far less reliable than the head's, and a wrong depth also scales
   * the sideways position (pixels are turned into metres at that depth). So: take the wrist's image
   * direction, re-project it at the head's depth (accurate lateral and vertical offsets), and trust
   * only a damped, clamped share of the hand's own depth relative to the head.
   */
  private wristRelativeToHead(J: Float32Array, out: THREE.Vector3): THREE.Vector3 {
    const wz = J[3 * WRIST + 2], hz = this.headPos.z;
    if (!(wz < -1e-3) || !(hz < -1e-3)) return out.fromArray(J, 3 * WRIST).sub(this.headPos);
    const k = hz / wz; // both negative (in front of the camera): rescale to the head's depth
    const towardsCamera = Math.min(0.3, Math.max(-0.1, 0.4 * (wz - hz)));
    return out.set(J[3 * WRIST] * k - this.headPos.x, J[3 * WRIST + 1] * k - this.headPos.y, towardsCamera);
  }

  /**
   * Keeps a wrist target out of the torso: tracked hands are positioned relative to the head, and a
   * real body is deeper than the tracked depth suggests, so held near the chest the avatar's hands
   * would sink into its own chest. Pushes the target in front of the chest and out to the side.
   * T is in world space; `scale` is avatar arm length / human arm length.
   */
  private keepClearOfBody(T: THREE.Vector3, sign: number, scale: number) {
    if (!this.chest) return;
    this.chest.getWorldPosition(_C);
    _qInv.copy(_qWrap).invert();
    const local = _L.copy(T).sub(_C).applyQuaternion(_qInv); // wrapper frame: x = avatar's left, z = forward
    const minForward = 0.17 * scale, minSide = 0.1 * scale;
    // Only near chest height: hands far above or below the torso can go anywhere.
    const nearTorso = local.y > -0.3 * scale && local.y < 0.3 * scale;
    if (nearTorso) {
      if (local.z < minForward) local.z = minForward;
      if (sign * local.x < minSide) local.x = sign * minSide;
    }
    T.copy(local.applyQuaternion(_qWrap)).add(_C);
  }

  private solveArm(arm: ArmRig, ik: boolean) {
    const { upper, lower, hand } = arm;
    if (!upper || !lower || !hand) return;
    // 1. Relaxed pose: arms hanging slightly out and forward, fingers straight.
    upper.quaternion.identity();
    lower.quaternion.identity();
    hand.quaternion.identity();
    for (let i = 0; i < arm.fingers.length; i++) arm.fingers[i].node.quaternion.identity();
    this.scene.getWorldQuaternion(_qWrap);
    aim(upper, arm.upperDir, _v0.set(arm.sign * 0.2, -1, -0.05).applyQuaternion(_qWrap));
    aim(lower, arm.lowerDir, _v0.set(arm.sign * 0.1, -1, 0.25).applyQuaternion(_qWrap));
    if (arm.weight <= 0 || !arm.seen) return;
    arm.relaxed[0].copy(upper.quaternion);
    arm.relaxed[1].copy(lower.quaternion);
    arm.relaxed[2].copy(hand.quaternion);
    for (let i = 0; i < arm.fingers.length; i++) arm.fingers[i].relaxed.copy(arm.fingers[i].node.quaternion);

    const J = arm.joints;
    // 2. Tracked hand orientation A (camera frame) and target world orientation Tq = wrap * A * rest.
    let haveOrientation = false;
    if (arm.hasBasis) {
      palmBasis(_v0.fromArray(J, 3 * WRIST), _v1.fromArray(J, 3 * INDEX_MCP), _v2.fromArray(J, 3 * MIDDLE_MCP),
        _v3.fromArray(J, 3 * PINKY_MCP), _m0);
      _m0.multiply(arm.restBasisT); // A = B_target * B_rest^T
      _q0.setFromRotationMatrix(_m0);
      _q1.copy(_qWrap).multiply(_q0).multiply(arm.handRestQ); // Tq
      haveOrientation = true;
    }

    // 3. Two-bone IK: wrist to the tracked wrist, relative to the head, scaled to the avatar's arm length.
    if (ik) {
      upper.getWorldPosition(_S);
      const L1 = _S.distanceTo(lower.getWorldPosition(_E));
      const L2 = _E.distanceTo(hand.getWorldPosition(_T));
      const scale = (L1 + L2) / HUMAN_ARM_LENGTH;
      // Anchor: avatar head centre; target = anchor + wrap * (wrist - trackedHead) * scale.
      this.getHeadPosition(_P).add(_v0.set(0, HEAD_CENTRE_ABOVE_HEAD_BONE * scale, 0).applyQuaternion(_qWrap));
      this.wristRelativeToHead(J, _T).multiplyScalar(scale).applyQuaternion(_qWrap).add(_P);
      this.keepClearOfBody(_T, arm.sign, scale);
      // Pole: elbows point down and out to the side, only slightly back (a natural carrying angle),
      // so the upper arm does not fold into the torso when the hands are near the chest.
      twoBoneIk(upper, lower, arm.upperDir, arm.lowerDir, _S, _T, L1, L2,
        _v1.set(arm.sign * 0.9, -1, -0.15).applyQuaternion(_qWrap));
      if (haveOrientation) setWorldQuaternion(hand, _q1);
    }

    // 4. Fingers: align each bone with its tracked segment, expressed relative to the avatar's hand
    //    (corr maps the tracked hand frame onto wherever the avatar's hand actually is).
    if (haveOrientation) hand.getWorldQuaternion(_qCorr).multiply(_q2.copy(_q1).invert());
    else _qCorr.identity();
    _qCorr.multiply(_qWrap);
    for (let i = 0; i < arm.fingers.length; i++) {
      const f = arm.fingers[i];
      _v0.fromArray(J, 3 * f.to).sub(_v1.fromArray(J, 3 * f.from)).applyQuaternion(_qCorr);
      aim(f.node, f.dir, _v0);
    }

    // 5. Blend from the relaxed pose by the fade weight.
    if (arm.weight < 1) {
      const w = arm.weight;
      blend(upper, arm.relaxed[0], w);
      blend(lower, arm.relaxed[1], w);
      blend(hand, arm.relaxed[2], w);
      for (let i = 0; i < arm.fingers.length; i++) blend(arm.fingers[i].node, arm.fingers[i].relaxed, w);
    }
  }
}

// --- helpers (allocation-free) -------------------------------------------------------

/** Rotates `node` (minimal arc) so its rest direction `dirLocal` points along world direction `target`. */
function aim(node: THREE.Object3D, dirLocal: THREE.Vector3, target: THREE.Vector3) {
  const parent = node.parent;
  if (!parent || target.lengthSq() < 1e-12) return;
  node.getWorldQuaternion(_q0);
  _v3.copy(dirLocal).applyQuaternion(_q0).normalize();
  _q2.setFromUnitVectors(_v3, _v2.copy(target).normalize());
  _q0.premultiply(_q2);
  parent.getWorldQuaternion(_q2).invert();
  node.quaternion.copy(_q2).multiply(_q0);
}

function setWorldQuaternion(node: THREE.Object3D, world: THREE.Quaternion) {
  if (!node.parent) return;
  node.parent.getWorldQuaternion(_q2).invert();
  node.quaternion.copy(_q2).multiply(world);
}

function blend(node: THREE.Object3D, from: THREE.Quaternion, w: number) {
  _q2.copy(node.quaternion);
  node.quaternion.slerpQuaternions(from, _q2, w);
}

/**
 * Orthonormal palm basis as matrix columns: x = forward (wrist -> middle MCP),
 * y = across the knuckles (pinky -> index, re-orthogonalised), z = x × y.
 */
function palmBasis(wrist: THREE.Vector3, index: THREE.Vector3, middle: THREE.Vector3, pinky: THREE.Vector3, out: THREE.Matrix4) {
  const f = _E.copy(middle).sub(wrist).normalize();
  const s = _P.copy(index).sub(pinky);
  const n = _S.crossVectors(f, s).normalize();
  s.crossVectors(n, f);
  out.makeBasis(f, s, n);
}

/** Places the elbow in the plane of shoulder, target and pole, then aims both bones. */
function twoBoneIk(upper: THREE.Object3D, lower: THREE.Object3D, upperDir: THREE.Vector3, lowerDir: THREE.Vector3,
  S: THREE.Vector3, T: THREE.Vector3, L1: number, L2: number, pole: THREE.Vector3) {
  if (L1 <= 0 || L2 <= 0) return;
  const u = _v0.copy(T).sub(S);
  let d = u.length();
  if (d < 1e-6) return;
  u.divideScalar(d);
  d = Math.min(Math.max(d, Math.abs(L1 - L2) + 1e-4), (L1 + L2) * 0.999);
  const cosA = Math.min(1, Math.max(-1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const p = pole.addScaledVector(u, -pole.dot(u));
  if (p.lengthSq() < 1e-8) p.set(0, -1, 0).addScaledVector(u, -u.y);
  p.normalize();
  // elbow = S + u·L1cosA + p·L1sinA ; reachable target = S + u·d
  const elbowDir = _v2.copy(u).multiplyScalar(cosA).addScaledVector(p, sinA);
  const reach = T.copy(S).addScaledVector(u, d);
  aim(upper, upperDir, elbowDir);
  const elbow = lower.getWorldPosition(_v0);
  aim(lower, lowerDir, reach.sub(elbow));
}
