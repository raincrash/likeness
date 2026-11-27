import * as THREE from "three";
import { patchCavity, patchEye, patchSkin } from "./skin.js";

/**
 * Everything about how the avatar looks: lights, environment, materials.
 * main.ts only talks to this through the Look interface.
 */
export interface Look {
  /** Material for an ICT mesh part, or null to hide the part. */
  materialFor(part: string): THREE.Material | null;
  /** Applies (or clears) the captured skin texture. The texture is sRGB with flipY = false. */
  setSkinTexture(texture: THREE.Texture | null): void;
  /** Called once with the head mesh after it is built (shadows, render order, ...). */
  configureHead(mesh: THREE.Mesh): void;
  setWireframe(on: boolean): void;
  /** Per-frame hook (optional animation of lights etc.). */
  update(dt: number): void;
  /** "high": soft key-light shadows and skin sheen. "low": neither (cheaper). Default "high". */
  setQuality?(quality: LookQuality): void;
  /** Turns the whole light rig and the environment about the vertical axis (radians). */
  setLightRotation?(rad: number): void;
  /** Tone-mapping exposure (default LOOK.exposure). */
  setExposure?(exposure: number): void;
}

export type LookQuality = "high" | "low";

/** Tuning knobs. Colours are sRGB hex; light intensities are three.js (physical) units. */
export const LOOK = {
  exposure: 1.0,
  /** Background radial gradient: centre (behind the head) and edge colours. */
  bgCenter: 0x23262d,
  bgEdge: 0x0b0c0f,

  /** Image-based lighting (procedural studio: key softbox, fill card, two rim strips). */
  envIntensity: 0.8,

  /** Key light: upper camera-right, ~40° round and ~30° up (loop lighting). Casts the shadow. */
  keyColor: 0xfff2e6,
  keyIntensity: 2.4,
  keyDir: [0.6, 0.5, 0.85] as const,
  /** Fill: low camera-left, cool, no shadow. */
  fillColor: 0xdbe6ff,
  fillIntensity: 0.45,
  fillDir: [-0.8, -0.05, 0.6] as const,
  /** Rims from behind: warm on the left, cool on the right. */
  rimLColor: 0xb3cfff,
  rimLIntensity: 1.8,
  rimLDir: [-0.85, 0.45, -0.75] as const,
  rimRColor: 0xd5e4ff,
  rimRIntensity: 1.1,
  rimRDir: [0.9, 0.3, -0.8] as const,

  /** Shadow map (key light only). Half-size of the orthographic shadow box around the head (m). */
  shadowMapSize: 1024,
  shadowExtent: 0.2,
  /** PCF filter radius in shadow-map texels: larger = softer penumbra. */
  shadowRadius: 5,
  shadowBias: -0.0002,
  /** World-space offset along the normal (m): fights acne on the CPU-deformed mesh. */
  shadowNormalBias: 0.0012,

  /** Skin. skinTint is the untextured colour; with a texture the colour is white x skinTextureGain. */
  skinTint: 0xd6a991,
  skinTextureGain: 1.0,
  skinRoughness: 0.52,
  /** 1 -> F0 0.04; skin is ~0.028. */
  skinSpecular: 0.7,
  skinSheen: 0.25,
  skinSheenRoughness: 0.55,
  skinSheenColor: 0xffe0d0,
  /** Wrap per RGB channel: red light bleeds further past the terminator (fake SSS). */
  skinWrap: [0.45, 0.2, 0.14] as const,
  /** Shadow penumbra exponent per RGB channel: < 1 keeps red in the soft edge. */
  skinShadowTint: [0.6, 1.0, 1.15] as const,
  skinEnvIntensity: 1.0,

  /** Eyes (vertex colours from main.ts are multiplied by eyeTint). */
  eyeTint: 0xe8e4e0,
  eyeRoughness: 0.3,
  eyeClearcoatRoughness: 0.04,
  /** Environment reflection strength on the eyes; high values wash the iris out at an angle. */
  eyeEnvIntensity: 0.35,
  /** Corner darkening [amount, start radius m, full radius m] and upper-lid darkening. */
  eyeCorner: [0.55, 0.006, 0.016] as const,
  eyeLid: 0.35,

  teethColor: 0xd8cebc,
  teethRoughness: 0.45,
  teethEnvIntensity: 0.5,
  /** Teeth darken from z = front (incisors, lit) to z = back (molars). */
  teethCavity: { back: 0.06, front: 0.102, min: 0.45 },

  mouthColor: 0x6e2c2c,
  mouthRoughness: 0.55,
  mouthEnvIntensity: 0.25,
  mouthCavity: { back: 0.075, front: 0.106, min: 0.06 },

  /** The fleshy lining behind the eyeballs that shows in the eye corners. */
  eyeSocketColor: 0x8a5048,
};

export function createLook(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Look {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral keeps albedo hues (ACES pushes skin orange, AgX greys it).
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = LOOK.exposure;
  renderer.shadowMap.enabled = true;
  // r187 removed PCFSoftShadowMap; PCF is now a rotated Vogel-disk filter whose softness is shadow.radius.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene.background = new THREE.Color(LOOK.bgEdge);
  scene.add(makeBackdrop());
  const env = makeStudioEnvironment(renderer);
  scene.environment = env;
  scene.environmentIntensity = LOOK.envIntensity;

  // --- light rig -------------------------------------------------------------
  const rig = new THREE.Group();
  rig.name = "look-rig";
  const dirLight = (color: number, intensity: number, dir: readonly number[]) => {
    const l = new THREE.DirectionalLight(color, intensity);
    l.position.set(dir[0], dir[1], dir[2]).normalize(); // 1 m from the head
    rig.add(l);
    return l; // target stays at the world origin = head pivot
  };
  const key = dirLight(LOOK.keyColor, LOOK.keyIntensity, LOOK.keyDir);
  dirLight(LOOK.fillColor, LOOK.fillIntensity, LOOK.fillDir);
  dirLight(LOOK.rimLColor, LOOK.rimLIntensity, LOOK.rimLDir);
  dirLight(LOOK.rimRColor, LOOK.rimRIntensity, LOOK.rimRDir);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -LOOK.shadowExtent;
  sc.right = sc.top = LOOK.shadowExtent;
  sc.near = 1 - 0.35;
  sc.far = 1 + 0.35;
  key.shadow.mapSize.set(LOOK.shadowMapSize, LOOK.shadowMapSize);
  key.shadow.radius = LOOK.shadowRadius;
  key.shadow.bias = LOOK.shadowBias;
  key.shadow.normalBias = LOOK.shadowNormalBias;
  key.castShadow = true;
  scene.add(rig);

  // --- materials -------------------------------------------------------------
  const skinTint = new THREE.Color(LOOK.skinTint);
  const skin = new THREE.MeshPhysicalMaterial({
    color: skinTint,
    roughness: LOOK.skinRoughness,
    specularIntensity: LOOK.skinSpecular,
    sheen: LOOK.skinSheen,
    sheenRoughness: LOOK.skinSheenRoughness,
    sheenColor: new THREE.Color(LOOK.skinSheenColor),
    envMapIntensity: LOOK.skinEnvIntensity,
  });
  patchSkin(skin, {
    uSkinWrap: { value: new THREE.Vector3(...LOOK.skinWrap) },
    uSkinShadowTint: { value: new THREE.Vector3(...LOOK.skinShadowTint) },
  });

  const eye = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    color: LOOK.eyeTint,
    roughness: LOOK.eyeRoughness,
    clearcoat: 1,
    clearcoatRoughness: LOOK.eyeClearcoatRoughness,
    envMapIntensity: LOOK.eyeEnvIntensity,
  });
  patchEye(eye, {
    uEyeCenter: { value: new THREE.Vector2(0.0316, 0.036) },
    uEyeCorner: { value: new THREE.Vector3(...LOOK.eyeCorner) },
    uEyeLid: { value: LOOK.eyeLid },
  });

  const teeth = new THREE.MeshStandardMaterial({
    color: LOOK.teethColor,
    roughness: LOOK.teethRoughness,
    envMapIntensity: LOOK.teethEnvIntensity,
  });
  patchCavity(teeth, {
    uCavityZ: { value: new THREE.Vector2(LOOK.teethCavity.back, LOOK.teethCavity.front) },
    uCavityMin: { value: LOOK.teethCavity.min },
  });

  const mouth = new THREE.MeshStandardMaterial({
    color: LOOK.mouthColor,
    roughness: LOOK.mouthRoughness,
    envMapIntensity: LOOK.mouthEnvIntensity,
  });
  patchCavity(mouth, {
    uCavityZ: { value: new THREE.Vector2(LOOK.mouthCavity.back, LOOK.mouthCavity.front) },
    uCavityMin: { value: LOOK.mouthCavity.min },
  });

  const eyeSocket = new THREE.MeshStandardMaterial({ color: LOOK.eyeSocketColor, roughness: 0.4, envMapIntensity: 0.3 });

  const materials = [skin, eye, teeth, mouth, eyeSocket];

  return {
    materialFor(part) {
      const p = part.toLowerCase();
      if (p.includes("occlusion") || p.includes("lacrimal") || p.includes("blend") || p.includes("sclera")) return null;
      if (p.includes("lash")) return null; // lash cards need an alpha texture; solid they read as eyeliner
      if (p.includes("iris") || p.includes("eyeball")) return eye;
      if (p.includes("eye_socket")) return eyeSocket;
      if (p.includes("teeth")) return teeth;
      if (p.includes("gum") || p.includes("tongue") || p.includes("mouth")) return mouth;
      return skin;
    },
    setSkinTexture(texture) {
      if (skin.map !== texture) {
        skin.map = texture;
        skin.needsUpdate = true;
      }
      if (texture) skin.color.setScalar(LOOK.skinTextureGain);
      else skin.color.copy(skinTint);
    },
    configureHead(mesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Vertices move on the CPU every frame, so a bounding sphere computed once can go stale.
      mesh.frustumCulled = false;
    },
    setWireframe(on) {
      for (const m of materials) m.wireframe = on;
    },
    update() {},
    setQuality(quality) {
      const high = quality === "high";
      renderer.shadowMap.enabled = high;
      key.castShadow = high;
      skin.sheen = high ? LOOK.skinSheen : 0;
      for (const m of materials) m.needsUpdate = true;
    },
    setLightRotation(rad) {
      rig.rotation.y = rad;
      scene.environmentRotation.y = rad;
    },
    setExposure(exposure) {
      renderer.toneMappingExposure = exposure;
    },
  };
}

/**
 * A procedural photo studio for image-based lighting: dark walls with a slightly lighter
 * ceiling, a large key softbox, a dim fill card and two tall rim strips, matching the
 * direct lights so the reflections line up with them. Rendered once into a PMREM.
 */
function makeStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const studio = new THREE.Scene();
  const room = new THREE.SphereGeometry(10, 32, 16);
  const pos = room.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0.06, 0.06, 0.065), mid = new THREE.Color(0.03, 0.03, 0.033), floor = new THREE.Color(0.035, 0.03, 0.027);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y > 0) c.copy(mid).lerp(top, y);
    else c.copy(mid).lerp(floor, -y);
    c.toArray(colors, i * 3);
  }
  room.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  studio.add(new THREE.Mesh(room, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));

  const panel = (w: number, h: number, dir: readonly number[], radiance: number, color: number, dist = 4) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(radiance), side: THREE.DoubleSide }),
    );
    m.position.set(dir[0], dir[1], dir[2]).normalize().multiplyScalar(dist);
    m.lookAt(0, 0, 0);
    studio.add(m);
  };
  panel(2.6, 2.6, LOOK.keyDir, 3.0, LOOK.keyColor); // key softbox
  panel(3.5, 2.0, LOOK.fillDir, 0.5, LOOK.fillColor); // fill card / bounce
  panel(0.6, 3.2, LOOK.rimLDir, 4.0, LOOK.rimLColor); // rim strips
  panel(0.6, 3.2, LOOK.rimRDir, 2.5, LOOK.rimRColor);
  panel(2.0, 2.0, [0, 1, 0.15], 0.8, 0xffffff); // soft overhead

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(studio, 0.02);
  pmrem.dispose();
  studio.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  return target.texture;
}

/**
 * Dithered radial-gradient backdrop drawn as a full-screen triangle behind everything.
 * Written straight out in sRGB (no tone mapping), with per-pixel dither so the dark
 * gradient doesn't band. Costs one cheap full-screen pass.
 */
function makeBackdrop(): THREE.Mesh {
  const srgb = (hex: number) => new THREE.Vector3((hex >> 16) & 255, (hex >> 8) & 255, hex & 255).divideScalar(255);
  const uniforms = {
    uCenter: { value: srgb(LOOK.bgCenter) },
    uEdge: { value: srgb(LOOK.bgEdge) },
    uAspect: { value: 1 },
  };
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec2 vNdc;
      void main() { vNdc = position.xy; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenter;
      uniform vec3 uEdge;
      uniform float uAspect;
      varying vec2 vNdc;
      void main() {
        vec2 p = vec2( vNdc.x * uAspect, vNdc.y - 0.08 );
        float t = smoothstep( 0.0, 1.0, length( p ) / 1.35 );
        vec3 c = mix( uCenter, uEdge, t );
        float n = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
        gl_FragColor = vec4( c + ( n - 0.5 ) / 255.0, 1.0 );
      }`,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.name = "look-backdrop";
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.onBeforeRender = (_r, _s, camera) => {
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) uniforms.uAspect.value = (camera as THREE.PerspectiveCamera).aspect;
  };
  return mesh;
}
