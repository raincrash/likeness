import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { IctModel } from "./ict.js";
import { createLook, type Look } from "./look.js";
import { TextureBaker, bakeMeshFor, expressionScore, type Projection } from "./bake.js";
import { HandRig } from "./hands.js";
import { ARKIT_BLENDSHAPES, ictArkitName, type HandOutput, type LikenessFrame } from "./frame.js";
import { assetUrl } from "./assets.js";

/**
 * LikenessAvatar: the bundled 3D renderer. It draws the ICT-FaceKit head (plus
 * rigged hands) from LikenessFrames, so it works with a local LikenessTracker
 * or with frames received from anywhere else (e.g. over a WebSocket).
 *
 *   const avatar = await LikenessAvatar.create({ container });
 *   tracker.on("frame", (f) => avatar.apply(f));
 */
export interface AvatarOptions {
  /** Element to render into; a canvas is created inside it and follows its size. */
  container: HTMLElement;
  /** Folder with ict.json / ict.bin (default: "<base>/ict"). */
  modelUrl?: string;
  /** Folder with left.glb / right.glb (default: "<base>/hands"). */
  handsUrl?: string;
  /** Show the avatar as a mirror image of the user (default true, like a webcam preview). */
  mirror?: boolean;
  /** "studio" (default gradient), "transparent" (for OBS / overlays) or any CSS colour. */
  background?: "studio" | "transparent" | string;
  /** Let the user orbit the camera with the mouse (default true). */
  orbit?: boolean;
  /** Render hands when frames contain them (default true; models load lazily). */
  hands?: boolean;
  /** Device pixel ratio cap (default 2). */
  maxPixelRatio?: number;
  /**
   * Camera framing: "head" (close-up), "upper-body" (room for the hands), or "auto" (default):
   * close-up until hands appear, then widen; back to the close-up a moment after they leave.
   * Orbiting or zooming with the mouse switches auto-framing off until setFraming() is called.
   */
  framing?: "auto" | "head" | "upper-body";
}

/** What a face scan needs from the tracker (LikenessTracker implements it). */
export interface ScanSource {
  readonly video: HTMLVideoElement;
  /** Camera-pixel -> head-model similarity of the latest frame. */
  readonly lastProjection: Projection["sim"] | null;
  readonly calibrated: boolean;
  calibrate(): void;
  /** Fits identity coefficients to the calibrated neutral face (and applies them to the tracker). */
  fitIdentity(): Float32Array | null;
  /** When present and false, the scan is aborted (e.g. the camera was stopped). */
  readonly isRunning?: boolean;
}

export interface ScanOptions {
  /** Aborts the scan; the promise then rejects with an AbortError. */
  signal?: AbortSignal;
  /** Give up if calibration has not finished after this many seconds (default 15). */
  calibrationTimeout?: number;
}

export interface ScanProgress {
  phase: "calibrating" | "capturing" | "done";
  /** 0..1 */
  progress: number;
  /** Human-readable instruction for the user. */
  message: string;
  coverage?: number;
}

export interface ScanResult {
  views: number;
  skipped: number;
  coverage: number;
  identity: Float32Array | null;
}

const SCAN_SECONDS = 9;

export class LikenessAvatar {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 1, 0.01, 10);
  readonly look: Look;
  readonly model: IctModel;
  /** Current ICT expression weights (model.expressionNames order). */
  readonly weights: Float32Array;
  /** Current identity coefficients (N(0,1) PCA weights). */
  readonly identity: Float32Array;
  controls: OrbitControls | null = null;

  private mirrorGroup = new THREE.Group();
  private pivot = new THREE.Group();
  private content = new THREE.Group();
  private head: THREE.Mesh;
  private bakeGeom: THREE.BufferGeometry;
  private scratchPos: Float32Array;
  private scratchNrm: Float32Array;
  private arkitIndex: Int16Array; // ICT expression -> index in ARKIT_BLENDSHAPES (or -1)
  private targetQuat = new THREE.Quaternion();
  private headPos = new THREE.Vector3(0, 0, -0.6);
  private hands: HandRig | null = null;
  private handsLoading: Promise<HandRig> | null = null;
  private baker: TextureBaker | null = null;
  private videoTexture: THREE.VideoTexture | null = null;
  private frameCallbacks = new Set<(dt: number) => void>();
  private raf = 0;
  private lastT = performance.now();
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private custom: THREE.Object3D | null = null;
  private scanning = false;
  private framing: "auto" | "head" | "upper-body" = "auto";
  private userCamera = false;
  private wide = 0; // 0 = head close-up, 1 = upper body
  private handsSeenAt = -Infinity;
  private frameTarget = new THREE.Vector3();
  private frameDir = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private abortScan: (() => void) | null = null;

  private constructor(private opts: AvatarOptions, model: IctModel) {
    this.model = model;
    this.weights = new Float32Array(model.nE);
    this.identity = new Float32Array(model.nI);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, opts.maxPixelRatio ?? 2));
    const canvas = this.renderer.domElement;
    canvas.style.cssText = "display:block;width:100%;height:100%";
    opts.container.appendChild(canvas);

    this.camera.position.set(0, 0, 0.9);
    this.look = createLook(this.renderer, this.scene);
    this.setBackground(opts.background ?? "studio");
    if (opts.orbit !== false) {
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = true;
      this.controls.addEventListener("start", () => (this.userCamera = true));
    }
    this.framing = opts.framing ?? "auto";

    this.mirrorGroup.add(this.pivot);
    this.pivot.add(this.content);
    this.scene.add(this.mirrorGroup);
    this.setMirror(opts.mirror ?? true);

    const built = buildHeadGeometry(model, this.look);
    this.head = built.mesh;
    this.bakeGeom = built.bakeGeom;
    this.look.configureHead(this.head);
    this.content.add(this.head);
    this.scratchPos = new Float32Array(model.nV * 3);
    this.scratchNrm = new Float32Array(model.nV * 3);
    // Inverse of ictToArkit: both halves of a split shape (browInnerUp_L/_R) take the ARKit value.
    this.arkitIndex = Int16Array.from(model.expressionNames, (n) => {
      const a = ictArkitName(n);
      return a ? ARKIT_BLENDSHAPES.indexOf(a) : -1;
    });
    this.updateMesh();

    // Pivot on the face region rather than the neck.
    const box = new THREE.Box3().setFromArray(model.neutral);
    const center = box.getCenter(new THREE.Vector3());
    center.y += (box.max.y - box.min.y) * 0.1;
    this.content.position.copy(center).negate();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(opts.container);
    this.resize();
    this.loop();
  }

  static async create(opts: AvatarOptions): Promise<LikenessAvatar> {
    const url = (opts.modelUrl ?? assetUrl("ict")).replace(/\/$/, "");
    const model = await IctModel.load(url);
    if (!model) throw new Error(`likeness: no face model at ${url}/ict.json. Copy dist/lib/assets into your public folder and call setAssetBase(), or pass modelUrl.`);
    return new LikenessAvatar(opts, model);
  }

  // --- driving ------------------------------------------------------------------

  /** Applies one tracking frame: expressions, head rotation and hands. */
  apply(frame: LikenessFrame): void {
    const face = frame.face;
    if (face) {
      const bs = face.blendshapes as Record<string, number>;
      this.arkitIndex.forEach((a, e) => {
        this.weights[e] = a >= 0 ? bs[ARKIT_BLENDSHAPES[a]] ?? 0 : 0;
      });
      const [x, y, z, w] = face.head.rotation;
      const len = Math.hypot(x, y, z, w);
      // A NaN target would stick: the pivot slerps towards it and never recovers.
      if (len > 1e-6 && Number.isFinite(len)) this.targetQuat.set(x / len, y / len, z / len, w / len);
      const [px, py, pz] = face.head.position;
      if (Number.isFinite(px + py + pz)) this.headPos.set(px, py, pz);
      this.updateMesh();
    }
    if (this.opts.hands !== false && frame.hands.length) {
      if (!this.hands) void this.loadHands();
      else this.hands.updateFromOutputs(this.placeHands(frame.hands), { cameraToScene: this.cameraToScene }, 0);
    }
  }

  /**
   * Moves each tracked hand (rigidly, keeping its size) so its wrist sits where the image says it is
   * relative to the head: MediaPipe's hand depth is much less reliable than the head's, and a depth
   * error also scales the sideways position. The wrist is re-projected at the head's depth, plus a
   * damped, clamped share of its own depth offset (same rule as VrmAvatar).
   */
  private placeHands(hands: readonly HandOutput[]): HandOutput[] {
    const hz = this.headPos.z;
    return hands.map((h, i) => {
      const w = h.joints[0];
      if (!(w[2] < -1e-3) || !(hz < -1e-3)) return h;
      const k = hz / w[2];
      const towardsCamera = Math.min(0.3, Math.max(-0.1, 0.4 * (w[2] - hz)));
      const dx = w[0] * k - w[0], dy = w[1] * k - w[1], dz = hz + towardsCamera - w[2];
      const out = (this.placedHands[i] ??= { side: h.side, score: 0, joints: Array.from({ length: 21 }, () => [0, 0, 0] as [number, number, number]) });
      out.side = h.side;
      out.score = h.score;
      h.joints.forEach((j, n) => {
        const o = out.joints[n];
        o[0] = j[0] + dx; o[1] = j[1] + dy; o[2] = j[2] + dz;
      });
      return out;
    });
  }

  private placedHands: HandOutput[] = [];

  /** Sets expression weights directly (ICT names and order: model.expressionNames). */
  setExpressionWeights(weights: ArrayLike<number>): void {
    this.weights.set(Array.from(weights).slice(0, this.weights.length));
    this.updateMesh();
  }

  /** Sets the head rotation directly (camera frame quaternion, see LikenessFrame). */
  setHeadRotation(q: THREE.Quaternion): void {
    this.targetQuat.copy(q);
  }

  /** Applies identity coefficients (N(0,1) PCA weights, up to model.nI). */
  setIdentity(coeffs: ArrayLike<number>): void {
    this.identity.fill(0);
    this.identity.set(Array.from(coeffs).slice(0, this.identity.length));
    this.model.setIdentity(this.identity);
    this.model.computeNormals(this.model.base, this.model.baseNormals);
    this.updateMesh();
  }

  /**
   * Camera-space point (metres, X right, Y up, Z = distance from camera) -> mirror-group
   * coordinates, relative to the head: the head pivot sits at the tracked head position.
   */
  readonly cameraToScene = (X: number, Y: number, Z: number, out: THREE.Vector3): THREE.Vector3 =>
    // headPos is the head model's origin; the display pivot sits at model point -content.position,
    // so shift by the rotated pivot offset as well (about 2 cm).
    out.set(X - this.headPos.x, Y - this.headPos.y, -Z - this.headPos.z)
      .add(this.pivotOffset.copy(this.content.position).applyQuaternion(this.pivot.quaternion));
  private pivotOffset = new THREE.Vector3();

  // --- appearance -----------------------------------------------------------------

  setMirror(on: boolean): void {
    this.mirrorGroup.scale.x = on ? -1 : 1;
    this.opts.mirror = on;
  }

  get mirrored(): boolean {
    return this.opts.mirror ?? true;
  }

  setBackground(bg: "studio" | "transparent" | string): void {
    this.opts.background = bg;
    const backdrop = this.scene.getObjectByName("look-backdrop");
    if (bg === "transparent") {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
      if (backdrop) backdrop.visible = false;
    } else if (bg === "studio") {
      this.scene.background = null;
      if (backdrop) backdrop.visible = true;
      this.renderer.setClearColor(0x0e0f12, 1);
    } else {
      if (backdrop) backdrop.visible = false;
      this.scene.background = new THREE.Color(bg);
      this.renderer.setClearColor(bg, 1);
    }
  }

  /** Sets the camera framing (see AvatarOptions.framing) and re-enables automatic framing. */
  setFraming(framing: "auto" | "head" | "upper-body"): void {
    this.framing = framing;
    this.userCamera = false;
  }

  /** Wireframe for everything on stage: the head, the hands and a custom avatar (e.g. a VRM). */
  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.look.setWireframe(on);
    this.applyWireframe();
  }

  private wireframe = false;

  private applyWireframe(): void {
    const set = (root: THREE.Object3D | null) =>
      root?.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) if ("wireframe" in mat) (mat as THREE.MeshBasicMaterial).wireframe = this.wireframe;
      });
    set(this.hands?.object ?? null);
    set(this.custom);
  }


  // --- face scan ------------------------------------------------------------------

  /**
   * Captures the user's head shape and skin texture (~10 s): calibrates a relaxed face, fits
   * identity, then bakes webcam views while the user turns their head slowly.
   */
  scanFace(source: ScanSource, onProgress?: (p: ScanProgress) => void, opts: ScanOptions = {}): Promise<ScanResult> {
    if (this.scanning) return Promise.reject(new Error("likeness: a face scan is already running"));
    this.baker ??= new TextureBaker(this.renderer, 2048, 1024, bakeMeshFor(this.model, this.bakeGeom));
    if (this.videoTexture?.image !== source.video) {
      this.videoTexture?.dispose();
      this.videoTexture = new THREE.VideoTexture(source.video);
    }
    const baker = this.baker, video = this.videoTexture;
    source.calibrate();
    let phase: "calibrating" | "capturing" = "calibrating";
    let identity: Float32Array | null = null;
    let start = 0, lastBake = 0, lastResolve = 0, textured = false;
    const begun = performance.now() / 1000;
    this.scanning = true;

    return new Promise((resolve, reject) => {
      const finish = (err: Error | null, result?: ScanResult) => {
        this.frameCallbacks.delete(step);
        this.abortScan = null;
        this.scanning = false;
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(result!);
      };
      const abortError = (why: string) => Object.assign(new Error(`likeness: face scan aborted (${why})`), { name: "AbortError" });
      const onAbort = () => finish(abortError("signal"));
      if (opts.signal?.aborted) return finish(abortError("signal"));
      opts.signal?.addEventListener("abort", onAbort);
      this.abortScan = () => finish(abortError("avatar disposed"));

      const step = () => {
        const now = performance.now() / 1000;
        if (source.isRunning === false) return finish(abortError("the video source stopped"));
        if (phase === "calibrating") {
          onProgress?.({ phase, progress: 0, message: "Hold still with a relaxed face…" });
          if (now - begun > (opts.calibrationTimeout ?? 15)) return finish(abortError("no calibrated face; is your face in view?"));
          if (!source.calibrated) return;
          identity = source.fitIdentity();
          if (identity) this.setIdentity(identity);
          baker.clear();
          phase = "capturing";
          start = lastResolve = now;
          return;
        }
        const elapsed = now - start;
        const message = elapsed < 2.5 ? "Look straight at the camera…" : elapsed < 5.5 ? "Slowly turn your head to one side…" : "…and now slowly to the other side";
        onProgress?.({ phase, progress: Math.min(1, elapsed / SCAN_SECONDS), message });
        const sim = source.lastProjection;
        if (sim && now - lastBake > 1 / 15) {
          lastBake = now;
          baker.accumulate(this.bakeGeom, video, {
            sim, width: source.video.videoWidth, height: source.video.videoHeight,
            expression: expressionScore(this.model.expressionNames, this.weights), time: now,
          });
        }
        if (now - lastResolve > 1 || elapsed >= SCAN_SECONDS) {
          lastResolve = now;
          const { coverage } = baker.resolve();
          if (!textured) {
            this.look.setSkinTexture(baker.texture);
            textured = true;
          }
          if (elapsed >= SCAN_SECONDS) {
            const st = baker.stats;
            const skipped = st.skipped.motion + st.skipped.expression + st.skipped.lighting;
            onProgress?.({ phase: "done", progress: 1, message: `Done: ${st.views} views, ${(coverage * 100).toFixed(0)}% of the skin captured.`, coverage });
            finish(null, { views: st.views, skipped, coverage, identity });
          }
        }
      };
      this.frameCallbacks.add(step);
    });
  }

  /** Removes the scanned texture and identity. */
  clearScan(): void {
    this.look.setSkinTexture(null);
    this.baker?.clear();
    this.setIdentity([]);
  }

  /** PNG of the scanned skin texture (null before a scan). */
  async exportTexture(): Promise<Blob | null> {
    return this.baker ? this.baker.toBlob() : null;
  }

  /** PNG snapshot of the current view. */
  snapshot(): Promise<Blob | null> {
    this.renderNow();
    return new Promise((res) => this.renderer.domElement.toBlob(res, "image/png"));
  }

  /**
   * Shows another 3D object instead of the built-in head and hands (e.g. a VrmAvatar's scene).
   * It is added to the scene unmirrored; pass null to go back to the built-in head.
   */
  setCustomAvatar(object: THREE.Object3D | null): void {
    if (this.custom) this.scene.remove(this.custom);
    this.custom = object;
    if (object) this.scene.add(object);
    this.applyWireframe();
    this.mirrorGroup.visible = !object;
  }

  /** Calls cb(dt) once per rendered frame, before rendering. Returns an unsubscribe function. */
  onRender(cb: (dt: number) => void): () => void {
    this.frameCallbacks.add(cb);
    return () => this.frameCallbacks.delete(cb);
  }

  /** For the texture baker in tests and dev tools. */
  get internals() {
    return { bakeGeom: this.bakeGeom, baker: this.baker, hands: this.hands, pivot: this.pivot, content: this.content };
  }

  // --- lifecycle ----------------------------------------------------------------------

  dispose(): void {
    this.abortScan?.();
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls?.dispose();
    this.baker?.dispose();
    this.videoTexture?.dispose();
    this.head.geometry.dispose();
    this.frameCallbacks.clear();
    this.renderer.dispose();
    // Release the WebGL context now: browsers cap live contexts (~16) and drop the oldest one,
    // e.g. the main avatar after a few demo-face (puppet) restarts.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private async loadHands(): Promise<HandRig> {
    this.handsLoading ??= HandRig.create((this.opts.handsUrl ?? assetUrl("hands")).replace(/\/$/, "")).then((rig) => {
      this.mirrorGroup.add(rig.object);
      this.hands = rig;
      this.applyWireframe();
      return rig;
    });
    return this.handsLoading;
  }

  /** Eases the camera between the head close-up and the upper-body shot. */
  private updateFraming(t: number, dt: number): void {
    if (this.userCamera) return;
    const st = this.hands?.state;
    if (st && (st.Left.visible || st.Right.visible)) this.handsSeenAt = t;
    const goal = this.framing === "upper-body" ? 1 : this.framing === "head" ? 0 : t - this.handsSeenAt < 2 ? 1 : 0;
    if (Math.abs(goal - this.wide) < 1e-4 && this.framingSettled) return;
    this.wide += (goal - this.wide) * (1 - Math.exp(-dt / 0.35));
    this.framingSettled = Math.abs(goal - this.wide) < 1e-4;
    const e = this.wide * this.wide * (3 - 2 * this.wide); // smoothstep
    const dist = 0.9 + 0.5 * e;
    this.frameTarget.set(0, -0.08 * e, 0);
    const target = this.controls?.target ?? this.lookTarget; // persistent: the direction must not drift
    this.frameDir.copy(this.camera.position).sub(target);
    if (this.frameDir.lengthSq() < 1e-8) this.frameDir.set(0, 0, 1);
    this.frameDir.normalize();
    target.copy(this.frameTarget);
    this.camera.position.copy(this.frameTarget).addScaledVector(this.frameDir, dist);
    if (!this.controls) this.camera.lookAt(this.frameTarget);
  }

  private framingSettled = false;

  private updateMesh(): void {
    const g = this.head.geometry;
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const nrm = g.getAttribute("normal") as THREE.BufferAttribute;
    this.model.evaluate(this.weights, this.scratchPos, this.scratchNrm);
    this.model.gather(this.scratchPos, pos.array as Float32Array);
    this.model.gather(this.scratchNrm, nrm.array as Float32Array);
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.opts.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private renderNow(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.frameCallbacks.forEach((cb) => cb(dt));
    this.pivot.quaternion.slerp(this.targetQuat, 0.5);
    this.hands?.updateFromOutputs([], { cameraToScene: this.cameraToScene }, dt);
    this.updateFraming(now / 1000, dt);
    this.look.update(dt);
    this.controls?.update();
    this.renderNow();
  };
}

/** Builds the render mesh (UV-split vertices, one group per part) and the skin-only bake geometry. */
function buildHeadGeometry(model: IctModel, look: Look) {
  const nR = model.nRender;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nR * 3), 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nR * 3), 3));
  // ICT uses UDIM tiles: face in u 0..1, head/neck in 1..2. Pack both into one 2:1 texture.
  const uv = new Float32Array(nR * 2);
  for (let r = 0; r < nR; r++) {
    uv[r * 2] = model.uv[r * 2] / 2;
    uv[r * 2 + 1] = model.uv[r * 2 + 1];
  }
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  const index: number[] = [];
  const skinIndex: number[] = [];
  const mats: THREE.Material[] = [];
  for (const [name, part] of Object.entries(model.meta.parts)) {
    const material = look.materialFor(name);
    if (!material) continue;
    const start = index.length;
    for (let t = part.tris[0] * 3; t < part.tris[1] * 3; t++) index.push(model.uvTris[t]);
    if (index.length === start) continue;
    if (name === "face" || name === "head_neck") skinIndex.push(...index.slice(start));
    mats.push(material);
    geom.addGroup(start, index.length - start, mats.length - 1);
  }
  geom.setIndex(index);
  const colors = new Float32Array(model.nV * 3).fill(1);
  paintEyes(model, colors);
  const renderColors = new Float32Array(nR * 3);
  model.gather(colors, renderColors);
  geom.setAttribute("color", new THREE.BufferAttribute(renderColors, 3));

  const bakeGeom = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) bakeGeom.setAttribute(name, geom.getAttribute(name));
  bakeGeom.setIndex(skinIndex);
  return { mesh: new THREE.Mesh(geom, mats), bakeGeom };
}

/**
 * ICT's eyes are an inner sphere ("iris", textured with the iris in the original) inside a
 * transparent cornea shell ("sclera"). Without textures we hide the shell and paint
 * pupil / iris / white onto the inner sphere.
 */
function paintEyes(m: IctModel, colors: Float32Array) {
  const pupil = new THREE.Color(0x070707), iris = new THREE.Color(0x5a3b26), irisEdge = new THREE.Color(0x2a1a10);
  const white = new THREE.Color(0xeee9e1), col = new THREE.Color();
  for (const side of ["iris_left", "iris_right"]) {
    const range = m.meta.parts[side]?.verts;
    if (!range) continue;
    const [a, b] = range;
    let cx = 0, cy = 0, cz = 0;
    for (let v = a; v < b; v++) { cx += m.neutral[v * 3]; cy += m.neutral[v * 3 + 1]; cz += m.neutral[v * 3 + 2]; }
    cx /= b - a; cy /= b - a; cz /= b - a;
    let R = 0;
    for (let v = a; v < b; v++) R = Math.max(R, Math.hypot(m.neutral[v * 3] - cx, m.neutral[v * 3 + 1] - cy));
    const irisR = R * 0.45, pupilR = irisR * 0.38;
    for (let v = a; v < b; v++) {
      const d = Math.hypot(m.neutral[v * 3] - cx, m.neutral[v * 3 + 1] - cy);
      const front = m.neutral[v * 3 + 2] > cz;
      if (front && d < pupilR) col.copy(pupil);
      else if (front && d < irisR) col.copy(iris).lerp(irisEdge, ((d - pupilR) / (irisR - pupilR)) ** 2);
      else col.copy(white);
      col.toArray(colors, v * 3);
    }
  }
}
