import * as THREE from "three";
import type { Mat3 } from "./solver.js";
import type { IctModel } from "./ict.js";
import { fitShading, ShadingNormalizer, defaultShFitOptions, type ShFitOptions } from "./sh.js";
import {
  LightSampler, prepareBakeMesh, genericBakeMesh, rotationAngle, toCamera, medianColor, texelsAt, featherFill,
  type BakeMesh,
} from "./bakecpu.js";

export type { BakeMesh } from "./bakecpu.js";

/**
 * Projective texture capture: for every tracked frame, the aligned face mesh is
 * rendered into UV space and each texel picks up the webcam colour it projects
 * to. Views are blended by how squarely the surface faces the camera, and a
 * depth prepass (rendered from the camera's point of view) stops occluded
 * surfaces, e.g. the cheek behind the nose, from picking up the wrong colour.
 *
 * Projection: the driver's similarity maps camera-pixel coordinates (x right,
 * y up, z towards camera, origin at image centre) into the model frame,
 * model = s R obs + t, so obs = R^T (model - t) / s. That is weak perspective,
 * which is accurate enough for a face at arm's length.
 *
 * Per view (accumulate):
 * 1. Gating: frames are skipped when the face moves fast in the image (motion
 *    blur: head rotation and translation speed from successive proj.sim) or,
 *    if proj.expression is given, when it exceeds a limit (blinks, open jaw,
 *    big smiles; see expressionScore).
 * 2. Delighting: the video is drawn into a small canvas, sampled at clean-skin
 *    vertices (front-facing, not occluded per a CPU depth splat), and a
 *    2nd-order SH shading is fitted per RGB channel (src/sh.ts, robust IRLS,
 *    regularised higher bands). The bake shader converts the video to linear,
 *    divides each texel by the normalised shading at its camera-frame normal
 *    (clamped at 0.25 of the mean), and accumulates linear albedo. The SH is
 *    normalised by the first accepted frame's brightness, so exposure and
 *    auto-gain swings between frames cancel.
 *
 * Resolve (~1 Hz):
 * 1. GPU: average colour per texel; texels seen poorly are blended with the
 *    mirrored texel (left/right symmetry of the neutral mesh), weighted so
 *    well-observed texels are never overwritten.
 * 2. GPU: mild unsharp mask clamped to the local min/max (no halos), then
 *    linear -> sRGB.
 * 3. CPU: median skin tone from cheeks and forehead, and a feathered fill of
 *    unseen texels from the nearest seen colour towards that skin tone.
 *
 * API (all extras optional; the original calls keep working):
 *   new TextureBaker(renderer, width = 2048, height = 1024, mesh?: BakeMesh, options?: Partial<BakeOptions>)
 *   baker.setMesh(mesh)              // BakeMesh from bakeMeshFor(model, bakeGeometry); enables the
 *                                    // clean-skin lighting fit, cheek/forehead skin tone and symmetry fill.
 *                                    // Without it: lighting uses all face-tile vertices, no symmetry fill.
 *   baker.accumulate(geometry, videoTexture, proj): boolean   // false if the frame was skipped
 *     proj.expression?: expressionScore(model.expressionNames, driver.weights), for expression gating
 *     proj.time?: frame time in seconds (defaults to performance.now())
 *   baker.resolve(): { coverage, skin }
 *   baker.stats: { views, skipped: { motion, expression, lighting }, cpuMs, cpuMsMax, gain, lightSamples }
 *   baker.options: BakeOptions (mutable)
 */
export interface Projection {
  sim: { s: number; R: Mat3; t: Float64Array };
  width: number;
  height: number;
  /** Optional expression strength (0..1), e.g. expressionScore(model.expressionNames, driver.weights). */
  expression?: number;
  /** Optional frame time in seconds, for the motion gate. Defaults to performance.now() / 1000. */
  time?: number;
}

export interface BakeOptions {
  /** Divide out the fitted SH lighting. */
  delight: boolean;
  /** Width of the CPU copy of the video used for the lighting fit. */
  sampleWidth: number;
  shFit: ShFitOptions;
  /** Temporal smoothing of the light's shape between frames (0 = none). */
  shTemporal: number;
  /** Lower clamp on shading, as a fraction of the mean brightness. */
  minShading: number;
  /** Skip frames whose face moves faster than this, in video widths per second. */
  maxImageSpeed: number;
  /** Skip frames whose proj.expression is above this. */
  expressionLimit: number;
  /** Strength of the symmetry fill (0 = off). */
  mirror: number;
  /** Unsharp-mask amount (0 = off). */
  sharpen: number;
  /** Feather width in texels for the unseen-region fill. */
  feather: number;
}

export const defaultBakeOptions: BakeOptions = {
  delight: true,
  sampleWidth: 160,
  shFit: defaultShFitOptions,
  shTemporal: 0.5,
  minShading: 0.25,
  maxImageSpeed: 0.2,
  expressionLimit: 0.7,
  mirror: 1,
  sharpen: 0.5,
  feather: 48,
};

export interface BakeStats {
  views: number;
  skipped: { motion: number; expression: number; lighting: number };
  /** CPU time of the last accumulate() (gating, video copy, lighting fit), and the max this scan. */
  cpuMs: number;
  cpuMsMax: number;
  /** Exposure gain of the last view relative to the first (per channel). */
  gain: [number, number, number];
  lightSamples: number;
}

/**
 * Largest expression weight that changes how the skin looks or where it is,
 * ignoring gaze and pupil channels (the eyes stay on the screen while the head
 * turns, so gaze weights are large on exactly the frames the scan wants).
 */
export function expressionScore(names: readonly string[], weights: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < names.length && i < weights.length; i++) {
    if (/^(eyeLook|Pupil)/.test(names[i])) continue;
    m = Math.max(m, weights[i]);
  }
  return m;
}

/** BakeMesh for the ICT model and the bake geometry built in main.ts (index + packed uv). */
export function bakeMeshFor(model: IctModel, geometry: THREE.BufferGeometry): BakeMesh {
  return prepareBakeMesh(model, geometry.getIndex()!.array, geometry.getAttribute("uv").array as Float32Array);
}

const projectGlsl = /* glsl */ `
  uniform mat3 uR;      // model <- camera rotation
  uniform vec3 uT;
  uniform float uS;
  uniform vec2 uSize;   // video size in pixels
  vec3 toCamera(vec3 p) { return transpose(uR) * (p - uT) / uS; }
  vec2 toImage(vec3 obs) { return obs.xy / uSize + 0.5; }
`;

const colorGlsl = /* glsl */ `
  vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 linearToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;

const DEPTH_RANGE = 4000;
const CONF_FULL = 0.6; // accumulated facing weight that counts as fully seen

export class TextureBaker {
  readonly width: number;
  readonly height: number;
  readonly options: BakeOptions;
  readonly stats: BakeStats = { views: 0, skipped: { motion: 0, expression: 0, lighting: 0 }, cpuMs: 0, cpuMsMax: 0, gain: [1, 1, 1], lightSamples: 0 };
  private accum: THREE.WebGLRenderTarget;
  private depth: THREE.WebGLRenderTarget;
  private linRT: THREE.WebGLRenderTarget;
  private resolveRT: THREE.WebGLRenderTarget;
  private depthMat: THREE.ShaderMaterial;
  private bakeMat: THREE.ShaderMaterial;
  private resolveMat: THREE.ShaderMaterial;
  private mirrorMat: THREE.ShaderMaterial;
  private sharpenMat: THREE.ShaderMaterial;
  private cam = new THREE.Camera();
  private quad: THREE.Mesh;
  private mirrorMesh: THREE.Mesh | null = null;
  private canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;

  private mesh: BakeMesh | null = null;
  private explicitMesh = false;
  private meshFor: THREE.BufferGeometry | null = null;
  private sample = document.createElement("canvas");
  private sampleCtx: CanvasRenderingContext2D | null = null;
  private sampler = new LightSampler(2000);
  private normalizer: ShadingNormalizer;
  private prev: { R: Float64Array; c: number[]; time: number } | null = null;
  private centroid: [number, number, number] = [0, 0, 0];
  private px: Uint8Array;
  private skinTexels: Uint32Array | null = null;

  constructor(private renderer: THREE.WebGLRenderer, width = 2048, height = 1024, mesh?: BakeMesh, options: Partial<BakeOptions> = {}) {
    this.width = width;
    this.height = height;
    this.options = { ...defaultBakeOptions, ...options };
    this.normalizer = new ShadingNormalizer(this.options.shTemporal, this.options.minShading);
    this.accum = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
    this.depth = new THREE.WebGLRenderTarget(512, 512, { type: THREE.FloatType, depthBuffer: true });
    this.linRT = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
    this.resolveRT = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
    this.px = new Uint8Array(width * height * 4);

    const uniforms = () => ({
      uR: { value: new THREE.Matrix3() },
      uT: { value: new THREE.Vector3() },
      uS: { value: 1 },
      uSize: { value: new THREE.Vector2(640, 480) },
    });

    this.depthMat = new THREE.ShaderMaterial({
      uniforms: uniforms(),
      vertexShader: /* glsl */ `
        ${projectGlsl}
        varying float vZ;
        void main() {
          vec3 obs = toCamera(position);
          vZ = obs.z;
          gl_Position = vec4(toImage(obs) * 2.0 - 1.0, clamp(-obs.z / ${DEPTH_RANGE.toFixed(1)}, -1.0, 1.0), 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vZ;
        void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }`,
      side: THREE.DoubleSide,
    });

    this.bakeMat = new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms(),
        uVideo: { value: null },
        uDepth: { value: this.depth.texture },
        uVideoEncoded: { value: 1 },
        uSH: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
        uShMin: { value: new THREE.Vector3() },
        uDelight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        ${projectGlsl}
        varying vec2 vImg;
        varying float vZ;
        varying vec3 vN;
        void main() {
          vec3 obs = toCamera(position);
          vImg = toImage(obs);
          vZ = obs.z;
          vN = transpose(uR) * normal;
          gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${colorGlsl}
        uniform sampler2D uVideo;
        uniform sampler2D uDepth;
        uniform float uVideoEncoded;
        uniform vec3 uSH[9];
        uniform vec3 uShMin;
        uniform float uDelight;
        varying vec2 vImg;
        varying float vZ;
        varying vec3 vN;
        vec3 shading(vec3 n) {
          vec3 s = uSH[0] * 0.282095
            + 0.488603 * (uSH[1] * n.y + uSH[2] * n.z + uSH[3] * n.x)
            + 1.092548 * (uSH[4] * n.x * n.y + uSH[5] * n.y * n.z + uSH[7] * n.x * n.z)
            + 0.315392 * uSH[6] * (3.0 * n.z * n.z - 1.0)
            + 0.546274 * uSH[8] * (n.x * n.x - n.y * n.y);
          return max(s, uShMin);
        }
        void main() {
          if (any(lessThan(vImg, vec2(0.01))) || any(greaterThan(vImg, vec2(0.99)))) discard;
          float front = texture2D(uDepth, vImg).r;
          if (vZ < front - 3.0) discard;               // occluded (units: video pixels)
          vec3 n = normalize(vN);
          float w = pow(max(n.z, 0.0), 2.0);
          if (w < 0.02) discard;
          vec3 c = texture2D(uVideo, vImg).rgb;
          if (uVideoEncoded > 0.5) c = srgbToLinear(c);
          if (uDelight > 0.5) c = min(c / shading(n), vec3(4.0));
          gl_FragColor = vec4(c * w, w);                // linear albedo, facing-weighted
        }`,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const resolveFrag = (mirror: boolean) => /* glsl */ `
      uniform sampler2D uAccum;
      uniform float uMirror;
      varying vec2 vUv;
      varying vec2 vMirror;
      void main() {
        vec4 a = texture2D(uAccum, vUv);
        ${mirror ? `
        // Poorly seen texels borrow the mirrored texel; well-seen ones (conf 1) are untouched.
        vec4 m = texture2D(uAccum, vMirror);
        float own = clamp(a.a / ${CONF_FULL}, 0.0, 1.0);
        a += m * uMirror * (1.0 - own) * (1.0 - own);` : ""}
        gl_FragColor = a.a > 0.0 ? vec4(a.rgb / a.a, clamp(a.a / ${CONF_FULL}, 0.0, 1.0)) : vec4(0.0);
      }`;
    const noBlend = { depthTest: false, depthWrite: false, blending: THREE.NoBlending } as const;
    this.resolveMat = new THREE.ShaderMaterial({
      uniforms: { uAccum: { value: this.accum.texture }, uMirror: { value: 0 } },
      vertexShader: `varying vec2 vUv; varying vec2 vMirror; void main() { vUv = uv; vMirror = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: resolveFrag(false),
      ...noBlend,
    });
    this.mirrorMat = new THREE.ShaderMaterial({
      uniforms: { uAccum: { value: this.accum.texture }, uMirror: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec2 mirrorUv;
        varying vec2 vUv;
        varying vec2 vMirror;
        void main() { vUv = position.xy; vMirror = mirrorUv; gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0); }`,
      fragmentShader: resolveFrag(true),
      side: THREE.DoubleSide,
      ...noBlend,
    });
    this.sharpenMat = new THREE.ShaderMaterial({
      uniforms: { uLin: { value: this.linRT.texture }, uStep: { value: new THREE.Vector2(2 / width, 2 / height) }, uAmount: { value: 0.5 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        ${colorGlsl}
        uniform sampler2D uLin;
        uniform vec2 uStep;     // 2 texels: the texture is ~2x the video's resolution on the face
        uniform float uAmount;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(uLin, vUv);
          if (c.a <= 0.0) { gl_FragColor = vec4(0.0); return; }
          vec3 sum = c.rgb * 4.0, lo = c.rgb, hi = c.rgb;
          float ws = 4.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            if (i == 0 && j == 0) continue;
            vec4 s = texture2D(uLin, vUv + vec2(float(i), float(j)) * uStep);
            if (s.a <= 0.0) continue;                   // other side of a uv seam / unseen
            float k = (i == 0 || j == 0) ? 2.0 : 1.0;   // 3x3 binomial
            sum += s.rgb * k; ws += k;
            lo = min(lo, s.rgb); hi = max(hi, s.rgb);
          }
          float amount = uAmount * smoothstep(0.3, 0.9, c.a);
          vec3 sharp = clamp(c.rgb + amount * (c.rgb - sum / ws), lo, hi); // clamp = no halos
          gl_FragColor = vec4(linearToSrgb(min(sharp, vec3(1.0))), c.a);
        }`,
      ...noBlend,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.resolveMat);
    this.quad.frustumCulled = false;

    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.anisotropy = 4;
    if (mesh) this.setMesh(mesh);
    this.clear();
  }

  get views(): number { return this.stats.views; }

  /** Sets the per-mesh data (see bakeMeshFor). Enables the symmetry fill. */
  setMesh(mesh: BakeMesh): void {
    this.mesh = mesh;
    this.explicitMesh = true;
    this.meshFor = null;
    this.skinTexels = mesh.skinRefUv.length ? texelsAt(mesh.skinRefUv, this.width, this.height) : null;
    this.mirrorMesh?.geometry.dispose();
    this.mirrorMesh = null;
    const n = mesh.mirrorTris.length / 4;
    if (!n) return;
    const pos = new Float32Array(n * 3), muv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = mesh.mirrorTris[i * 4]; pos[i * 3 + 1] = mesh.mirrorTris[i * 4 + 1];
      muv[i * 2] = mesh.mirrorTris[i * 4 + 2]; muv[i * 2 + 1] = mesh.mirrorTris[i * 4 + 3];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("mirrorUv", new THREE.BufferAttribute(muv, 2));
    this.mirrorMesh = new THREE.Mesh(g, this.mirrorMat);
    this.mirrorMesh.frustumCulled = false;
  }

  clear(): void {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.accum);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.setRenderTarget(prev);
    this.stats.views = 0;
    this.stats.skipped = { motion: 0, expression: 0, lighting: 0 };
    this.stats.cpuMs = this.stats.cpuMsMax = 0;
    this.stats.gain = [1, 1, 1];
    this.normalizer.reset();
    this.prev = null;
  }

  /** Lighting / skin data for `geometry`: the explicit BakeMesh, or a generic one from the geometry. */
  private meshData(geometry: THREE.BufferGeometry): BakeMesh {
    if (this.meshFor !== geometry || !this.mesh) {
      if (!this.explicitMesh || !this.mesh) {
        this.mesh = genericBakeMesh(geometry.getIndex()!.array, geometry.getAttribute("uv").array as Float32Array);
      }
      this.meshFor = geometry;
      const pos = geometry.getAttribute("position").array as Float32Array, lv = this.mesh.lightVerts;
      const c: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < lv.length; i++) for (let k = 0; k < 3; k++) c[k] += pos[lv[i] * 3 + k] / lv.length;
      this.centroid = c;
    }
    return this.mesh;
  }

  /**
   * Adds one camera view. `geometry` must carry model-frame position, normal
   * and uv. Returns false when the frame was skipped (see stats.skipped).
   */
  accumulate(geometry: THREE.BufferGeometry, video: THREE.Texture, proj: Projection): boolean {
    const t0 = performance.now();
    const opt = this.options, st = this.stats;
    const { s, R, t } = proj.sim;
    const mesh = this.meshData(geometry);

    // 1. Gating.
    const time = proj.time ?? t0 / 1000;
    const centre = toCamera(proj.sim, this.centroid[0], this.centroid[1], this.centroid[2]);
    const prev = this.prev;
    this.prev = { R: Float64Array.from(R), c: centre, time };
    const done = (ok: boolean) => {
      st.cpuMs = performance.now() - t0;
      st.cpuMsMax = Math.max(st.cpuMsMax, st.cpuMs);
      return ok;
    };
    if (proj.expression !== undefined && proj.expression > opt.expressionLimit) { st.skipped.expression++; return done(false); }
    if (prev) {
      const dt = time - prev.time;
      if (dt > 0.005 && dt < 0.5) {
        const faceRadiusPx = 0.08 / s;
        const speed = (Math.hypot(centre[0] - prev.c[0], centre[1] - prev.c[1]) + rotationAngle(prev.R, R) * faceRadiusPx) / dt;
        if (speed > opt.maxImageSpeed * proj.width) { st.skipped.motion++; return done(false); }
      }
    }

    // 2. Lighting fit.
    const u = this.bakeMat.uniforms;
    u.uDelight.value = 0;
    if (opt.delight) {
      const img = this.grabVideo(video, proj.width, proj.height);
      if (img) {
        const pos = geometry.getAttribute("position").array as Float32Array;
        const nrm = geometry.getAttribute("normal").array as Float32Array;
        const smp = this.sampler.sample(pos, nrm, mesh, proj.sim, proj.width, proj.height, img);
        st.lightSamples = smp.count;
        const fit = smp.count >= 80 ? fitShading(smp.normals, smp.colors, smp.count, opt.shFit) : null;
        this.normalizer.temporal = opt.shTemporal;
        this.normalizer.minFraction = opt.minShading;
        if (!fit || fit.inliers < 40 || !this.normalizer.update(fit)) { st.skipped.lighting++; return done(false); }
        const nz = this.normalizer;
        for (let k = 0; k < 9; k++) (u.uSH.value as THREE.Vector3[])[k].set(nz.coeffs[k], nz.coeffs[9 + k], nz.coeffs[18 + k]);
        (u.uShMin.value as THREE.Vector3).set(nz.min[0], nz.min[1], nz.min[2]);
        st.gain = [nz.gain[0], nz.gain[1], nz.gain[2]];
        u.uDelight.value = 1;
      } else if (this.normalizer.ref) {
        st.skipped.lighting++; // don't mix an un-delit view into a delit texture
        return done(false);
      }
    }
    done(true);

    // 3. GPU bake.
    for (const m of [this.depthMat, this.bakeMat]) {
      m.uniforms.uR.value.set(R[0], R[1], R[2], R[3], R[4], R[5], R[6], R[7], R[8]);
      m.uniforms.uT.value.set(t[0], t[1], t[2]);
      m.uniforms.uS.value = s;
      m.uniforms.uSize.value.set(proj.width, proj.height);
    }
    u.uVideo.value = video;
    // Video textures are always uploaded as raw sRGB bytes (three.js forces a linear transfer for
    // them); other sRGB-tagged textures are decoded by the GPU on sampling.
    u.uVideoEncoded.value = video.colorSpace === THREE.SRGBColorSpace && !(video as THREE.VideoTexture).isVideoTexture ? 0 : 1;

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    const meshObj = new THREE.Mesh(geometry, this.depthMat);
    meshObj.frustumCulled = false;
    r.setRenderTarget(this.depth);
    r.setClearColor(new THREE.Color(-1e4, 0, 0), 1);
    r.clear(true, true, false);
    r.render(meshObj, this.cam);

    meshObj.material = this.bakeMat;
    r.setRenderTarget(this.accum);
    r.render(meshObj, this.cam);

    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    r.autoClear = prevAutoClear;
    st.views++;
    return true;
  }

  /** Downscaled CPU copy of the current video frame (rows top to bottom), or null if unavailable. */
  private grabVideo(video: THREE.Texture, w: number, h: number): ImageData | null {
    const src = video.image as CanvasImageSource & { readyState?: number };
    if (!src || (typeof src.readyState === "number" && src.readyState < 2) || !w || !h) return null;
    const cw = Math.max(16, Math.round(this.options.sampleWidth)), ch = Math.max(9, Math.round(cw * h / w));
    if (this.sample.width !== cw || this.sample.height !== ch) { this.sample.width = cw; this.sample.height = ch; }
    this.sampleCtx ??= this.sample.getContext("2d", { willReadFrequently: true });
    const ctx = this.sampleCtx;
    if (!ctx) return null;
    try {
      ctx.drawImage(src, 0, 0, cw, ch);
      return ctx.getImageData(0, 0, cw, ch);
    } catch {
      return null; // e.g. a cross-origin video: bake without delighting
    }
  }

  /**
   * Resolves the accumulation into `texture`. Poorly seen texels borrow from
   * the mirrored side, the result is lightly sharpened, and texels never seen
   * fade from the nearest seen colour to the median cheek/forehead skin tone.
   */
  resolve(): { coverage: number; skin: [number, number, number] } {
    const r = this.renderer, w = this.width, h = this.height, n = w * h, opt = this.options;
    const prev = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.linRT);
    this.quad.material = this.resolveMat;
    r.render(this.quad, this.cam);
    if (this.mirrorMesh && opt.mirror > 0) {
      this.mirrorMat.uniforms.uMirror.value = opt.mirror;
      r.render(this.mirrorMesh, this.cam);
    }
    r.setRenderTarget(this.resolveRT);
    this.sharpenMat.uniforms.uAmount.value = opt.sharpen;
    this.quad.material = this.sharpenMat;
    r.render(this.quad, this.cam);
    const px = this.px;
    r.readRenderTargetPixels(this.resolveRT, 0, 0, w, h, px);
    r.setRenderTarget(prev);
    r.autoClear = prevAutoClear;

    let covered = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]) covered++;
    const skin = this.skinTone(px);
    const img = new ImageData(w, h);
    featherFill(px, w, h, skin, img.data, { feather: opt.feather, block: 4 });
    this.canvas.getContext("2d")!.putImageData(img, 0, 0);
    this.texture.needsUpdate = true;
    return { coverage: covered / n, skin };
  }

  /** Median colour of confidently seen cheek/forehead texels (falls back to the face tile). */
  private skinTone(px: Uint8Array): [number, number, number] {
    if (this.skinTexels) {
      const m = medianColor(px, this.skinTexels, 200);
      if (m) return m;
    }
    const w = this.width, h = this.height, all: number[] = [];
    for (let y = 0; y < h; y += 5) for (let x = 0; x < w / 2; x += 5) all.push(y * w + x);
    return medianColor(px, all, 200) ?? [200, 170, 150];
  }

  /** PNG of the current texture (rows as stored: v = 0 at the top of the image). */
  toBlob(): Promise<Blob | null> {
    return new Promise((res) => this.canvas.toBlob(res, "image/png"));
  }

  dispose(): void {
    this.accum.dispose();
    this.depth.dispose();
    this.linRT.dispose();
    this.resolveRT.dispose();
    this.mirrorMesh?.geometry.dispose();
    this.texture.dispose();
  }
}
