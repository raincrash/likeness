import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { HandFrame } from "./handTracker.js";
import type { HandOutput } from "./frame.js";
import { HandSmoother } from "./handFilter.js";
import { HAND_CONNECTIONS, N_JOINTS, N_LANDMARKS, XR_JOINTS, palmSize, type Handedness } from "./handMath.js";
import { makeRest, solvePose, type HandRest } from "./handRetarget.js";

/** How hand landmarks get into the scene; main.ts implements cameraToScene from the head alignment. */
export interface HandPlacement {
  videoWidth: number;
  videoHeight: number;
  /** Focal length in video pixels. */
  focalPx: number;
  /**
   * Camera metric point (X right, Y up in metres from the optical axis; Z = distance from the
   * camera, positive) -> coordinates of HandRig.object's parent.
   */
  cameraToScene(X: number, Y: number, Z: number, out: THREE.Vector3): THREE.Vector3;
}

/** Seconds without a detection before a hand hides, and how long the scale-down takes. */
const HIDE_AFTER = 0.3;
const FADE_TIME = 0.15;

const SKIN = 0xd39a7c;

interface Pose {
  setMaterial(m: THREE.Material): void;
  /** scene: 21*3 landmarks in the parent's frame, relative to the wrist. */
  apply(scene: Float32Array): void;
}

/** Drives a WebXR generic-hand skinned mesh. Bones are direct children of the armature. */
class SkinnedPose implements Pose {
  private bones: THREE.Bone[];
  private rest: HandRest;
  private pos = new Float32Array(N_JOINTS * 3);
  private quat = new Float32Array(N_JOINTS * 4);
  private meshes: THREE.SkinnedMesh[] = [];

  constructor(private armature: THREE.Object3D, bones: THREE.Bone[]) {
    this.bones = bones;
    const pos = new Float32Array(N_JOINTS * 3), quat = new Float32Array(N_JOINTS * 4);
    bones.forEach((b, j) => { b.position.toArray(pos, j * 3); b.quaternion.toArray(quat, j * 4); });
    this.rest = makeRest(pos, quat);
    armature.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        const m = o as THREE.SkinnedMesh;
        m.frustumCulled = false; // bounds are the bind pose's, not the tracked one
        m.castShadow = true;
        this.meshes.push(m);
      }
    });
  }

  setMaterial(material: THREE.Material) {
    for (const m of this.meshes) m.material = material;
  }

  apply(scene: Float32Array) {
    // Armature space = parent space scaled by k (rotation-free), so world rotations are local ones.
    const k = solvePose(this.rest, scene, this.pos, this.quat);
    this.armature.scale.setScalar(k);
    this.bones.forEach((b, j) => {
      b.position.fromArray(this.pos, j * 3).divideScalar(k);
      b.quaternion.fromArray(this.quat, j * 4);
    });
  }
}

/** Fallback: spheres at the landmarks and cylinders along MediaPipe's connections. */
class ProceduralPose implements Pose {
  private joints: THREE.InstancedMesh;
  private links: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private s = new THREE.Vector3();
  private static readonly Y = new THREE.Vector3(0, 1, 0);

  constructor(group: THREE.Group, material: THREE.Material) {
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), material, N_LANDMARKS);
    this.links = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1, true), material, HAND_CONNECTIONS.length);
    for (const mesh of [this.joints, this.links]) {
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      group.add(mesh);
    }
  }

  setMaterial(material: THREE.Material) {
    this.joints.material = this.links.material = material;
  }

  apply(scene: Float32Array) {
    // Radii relative to an average palm (wrist to MCP ~ 8.5 cm).
    const k = palmSize(scene) / 0.085;
    const radius = (l: number) => k * (l === 0 ? 0.013 : l % 4 === 1 && l > 1 ? 0.0105 : l % 4 === 0 ? 0.0075 : 0.009);
    for (let l = 0; l < N_LANDMARKS; l++) {
      const r = radius(l);
      this.m.makeScale(r, r, r).setPosition(scene[l * 3], scene[l * 3 + 1], scene[l * 3 + 2]);
      this.joints.setMatrixAt(l, this.m);
    }
    HAND_CONNECTIONS.forEach(([i, j], c) => {
      this.a.fromArray(scene, i * 3);
      this.b.fromArray(scene, j * 3).sub(this.a);
      const len = this.b.length();
      const r = Math.min(radius(i), radius(j)) * 0.92;
      this.q.setFromUnitVectors(ProceduralPose.Y, this.b.divideScalar(len || 1));
      this.a.addScaledVector(this.b, len / 2);
      this.m.compose(this.a, this.q, this.s.set(r, len, r));
      this.links.setMatrixAt(c, this.m);
    });
    this.joints.instanceMatrix.needsUpdate = this.links.instanceMatrix.needsUpdate = true;
  }
}

/** One tracked hand: smoothing (HandSmoother), visibility and its pose driver. */
class HandSlot {
  readonly group = new THREE.Group();
  readonly smoother = new HandSmoother();
  lastSeen = -Infinity;
  private vis = 0;
  private scene = new Float32Array(63);
  private v = new THREE.Vector3();
  private wrist = new THREE.Vector3();

  constructor(readonly side: Handedness, public pose: Pose) {
    this.group.name = `hand-${side.toLowerCase()}`;
    this.group.visible = false;
  }

  /** Smoothed depth (m), for display. */
  get depth(): number {
    return this.smoother.depth;
  }

  /** Raw detection: smooth it, then pose. */
  track(frame: HandFrame, ctx: HandPlacement, t: number) {
    const cam = this.smoother.push(frame, ctx, t);
    if (cam) this.trackCamera(cam, ctx, t);
  }

  /** Already-smoothed camera points (X right, Y up, Z = distance, metres): just pose. */
  trackCamera(cam: ArrayLike<number>, ctx: Pick<HandPlacement, "cameraToScene">, t: number) {
    ctx.cameraToScene(cam[0], cam[1], cam[2], this.wrist);
    for (let i = 0; i < N_LANDMARKS; i++) {
      ctx.cameraToScene(cam[i * 3], cam[i * 3 + 1], cam[i * 3 + 2], this.v).sub(this.wrist);
      this.v.toArray(this.scene, i * 3);
    }
    // Collapsed or non-finite joints (e.g. a bad network frame) would give NaN bone transforms.
    if (!(palmSize(this.scene) > 1e-4) || !Number.isFinite(this.wrist.x + this.wrist.y + this.wrist.z)) return;
    this.group.position.copy(this.wrist);
    this.pose.apply(this.scene);
    this.lastSeen = t;
  }

  /** Scale-down fade after HIDE_AFTER seconds without a detection. */
  animate(t: number, dt: number) {
    const target = t - this.lastSeen <= HIDE_AFTER ? 1 : 0;
    this.vis = target > this.vis ? 1 : Math.max(0, this.vis - dt / FADE_TIME);
    const s = 1 - (1 - this.vis) ** 2;
    this.group.scale.setScalar(Math.max(s, 1e-4));
    this.group.visible = this.vis > 0;
  }
}

export class HandRig {
  /** Add to the mirror group, next to the head pivot. */
  readonly object = new THREE.Group();
  /** Whether the rigged glb loaded (false: procedural fallback). */
  readonly rigged: boolean;
  private slots: Record<Handedness, HandSlot>;
  private _material: THREE.Material;
  private t = 0;
  private camBuf = new Float32Array(N_LANDMARKS * 3);

  private constructor(poses: Record<Handedness, (g: THREE.Group, m: THREE.Material) => Pose>, rigged: boolean) {
    this.object.name = "hands";
    this.rigged = rigged;
    this._material = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.6, metalness: 0 });
    const slot = (side: Handedness) => {
      const s = new HandSlot(side, null as unknown as Pose);
      s.pose = poses[side](s.group, this._material);
      this.object.add(s.group);
      return s;
    };
    this.slots = { Left: slot("Left"), Right: slot("Right") };
  }

  /** baseUrl: the folder with left.glb / right.glb, e.g. `${import.meta.env.BASE_URL}hands`. */
  static async create(baseUrl: string): Promise<HandRig> {
    const base = baseUrl.replace(/\/$/, "");
    const loader = new GLTFLoader();
    const load = async (side: Handedness) => {
      const gltf = await loader.loadAsync(`${base}/${side.toLowerCase()}.glb`);
      const bones = XR_JOINTS.map((name) => {
        const b = gltf.scene.getObjectByName(name);
        if (!(b as THREE.Bone | undefined)?.isBone) throw new Error(`hand model ${side}: no bone "${name}"`);
        return b as THREE.Bone;
      });
      const armature = bones[0].parent!;
      if (bones.some((b) => b.parent !== armature)) throw new Error(`hand model ${side}: bones are not siblings`);
      return { scene: gltf.scene, armature, bones };
    };
    try {
      const [l, r] = await Promise.all([load("Left"), load("Right")]);
      const rig = (a: typeof l) => (g: THREE.Group, m: THREE.Material) => {
        g.add(a.scene);
        // Keep only the armature's scale under our control: the glb's scene root is the identity.
        a.scene.position.set(0, 0, 0); a.scene.quaternion.identity(); a.scene.scale.setScalar(1);
        a.armature.position.set(0, 0, 0); a.armature.quaternion.identity();
        const p = new SkinnedPose(a.armature, a.bones);
        p.setMaterial(m);
        return p;
      };
      return new HandRig({ Left: rig(l), Right: rig(r) }, true);
    } catch (err) {
      console.warn("Hand models failed to load; using procedural hands.", err);
      const proc = (g: THREE.Group, m: THREE.Material) => new ProceduralPose(g, m);
      return new HandRig({ Left: proc, Right: proc }, false);
    }
  }

  get material(): THREE.Material {
    return this._material;
  }

  /** Shares a material (e.g. the look's skin material) with both hands. */
  setMaterial(material: THREE.Material): void {
    this._material = material;
    for (const s of Object.values(this.slots)) s.pose.setMaterial(material);
  }

  /**
   * Call every render frame: `hands` holds the detections of a new video frame, or [] when there is
   * none (the hands then hold their pose and hide after 300 ms). dt in seconds.
   */
  update(hands: HandFrame[], ctx: HandPlacement, dt: number): void {
    this.t += Math.max(0, Math.min(dt, 0.25));
    for (const h of hands) this.slots[h.handedness].track(h, ctx, this.t);
    for (const s of Object.values(this.slots)) s.animate(this.t, dt);
  }

  /**
   * Like update(), but from public LikenessFrame hands (already smoothed, camera frame with the
   * hand at negative z), e.g. frames received over the network.
   */
  updateFromOutputs(hands: HandOutput[], ctx: Pick<HandPlacement, "cameraToScene">, dt: number): void {
    this.t += Math.max(0, Math.min(dt, 0.25));
    for (const h of hands) {
      if (!h.joints || h.joints.length < N_LANDMARKS) continue; // e.g. a malformed frame from the network
      for (let i = 0; i < N_LANDMARKS; i++) {
        const j = h.joints[i];
        this.camBuf[i * 3] = j[0]; this.camBuf[i * 3 + 1] = j[1]; this.camBuf[i * 3 + 2] = -j[2];
      }
      this.slots[h.side === "left" ? "Left" : "Right"].trackCamera(this.camBuf, ctx, this.t);
    }
    for (const s of Object.values(this.slots)) s.animate(this.t, dt);
  }

  setVisible(v: boolean): void {
    this.object.visible = v;
  }

  /** For the status line and debugging: smoothed depth (m) and visibility per hand. */
  get state() {
    const one = (s: HandSlot) => ({ visible: s.group.visible, depth: s.depth });
    return { Left: one(this.slots.Left), Right: one(this.slots.Right) };
  }
}
