import * as THREE from "three";

/**
 * Cheap shader patches for the head materials (all applied through onBeforeCompile,
 * so they ride on three's MeshStandard / MeshPhysical lighting):
 *
 * - patchSkin: per-channel wrap lighting (red light wraps further round the terminator,
 *   a cheap stand-in for subsurface scattering) and a reddish shadow penumbra.
 * - patchCavity: fakes occlusion inside the mouth from object-space depth behind the lips.
 * - patchEye: darkens the eyeball towards the eye corners and under the upper lid.
 *
 * Object space here is the head's own frame (metres, +z forward, +y up): the CPU writes
 * deformed vertices there and the head pose lives on parent groups, so the occlusion
 * regions follow the head.
 */

type Shader = THREE.WebGLProgramParametersWithUniforms;

export interface SkinUniforms {
  /** Wrap amount per RGB channel (0 = Lambert). Red wraps furthest. */
  uSkinWrap: { value: THREE.Vector3 };
  /** Shadow penumbra exponent per RGB channel (< 1 lingers, > 1 falls off faster). */
  uSkinShadowTint: { value: THREE.Vector3 };
}

const SHADOW_LINE =
  /directLight\.color \*= (\( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \][^;]*\) : 1\.0);/;
const DIFFUSE_LINE = "reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );";

let warned = false;
function warnOnce(what: string) {
  if (warned) return;
  warned = true;
  console.warn(`look: three.js shader chunk changed, skipping the ${what} patch`);
}

export function patchSkin(material: THREE.Material, uniforms: SkinUniforms) {
  material.customProgramCacheKey = () => "look-skin";
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, uniforms);
    let pars = THREE.ShaderChunk.lights_physical_pars_fragment;
    if (pars.includes(DIFFUSE_LINE)) {
      pars = pars.replace(
        DIFFUSE_LINE,
        /* glsl */ `
        vec3 skinNL = saturate( ( dot( geometryNormal, directLight.direction ) + uSkinWrap ) / ( 1.0 + uSkinWrap ) );
        vec3 skinIrradiance = skinNL * directLight.color;
        #ifdef USE_SHEEN
          skinIrradiance *= sheenEnergyComp;
        #endif
        reflectedLight.directDiffuse += skinIrradiance * diffuseBRDF * ( 1.0 - F );`,
      );
    } else warnOnce("wrap lighting");
    let begin = THREE.ShaderChunk.lights_fragment_begin;
    if (SHADOW_LINE.test(begin)) begin = begin.replace(SHADOW_LINE, "directLight.color *= skinShadow( $1 );");
    else warnOnce("shadow tint");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform vec3 uSkinWrap;
        uniform vec3 uSkinShadowTint;
        vec3 skinShadow( float s ) { return pow( vec3( max( s, 1e-4 ) ), uSkinShadowTint ); }`,
      )
      .replace("#include <lights_physical_pars_fragment>", pars)
      .replace("#include <lights_fragment_begin>", begin);
  };
}

/** Adds an object-space position varying and multiplies the lit colour by `occlusion(p)`. */
function patchOcclusion(material: THREE.Material, key: string, uniforms: Record<string, THREE.IUniform>, glsl: string) {
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLookObj;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLookObj = transformed;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vLookObj;\n${glsl}`)
      .replace("#include <opaque_fragment>", "outgoingLight *= lookOcclusion( vLookObj );\n#include <opaque_fragment>");
  };
}

export interface CavityUniforms {
  /** x: depth (object z) where it is fully dark, y: depth where it is fully lit. */
  uCavityZ: { value: THREE.Vector2 };
  /** Light multiplier at full depth. */
  uCavityMin: { value: number };
}

export function patchCavity(material: THREE.Material, uniforms: CavityUniforms) {
  patchOcclusion(
    material,
    "look-cavity",
    uniforms as unknown as Record<string, THREE.IUniform>,
    /* glsl */ `
    uniform vec2 uCavityZ;
    uniform float uCavityMin;
    float lookOcclusion( vec3 p ) {
      float t = smoothstep( uCavityZ.x, uCavityZ.y, p.z );
      return mix( uCavityMin, 1.0, t * t );
    }`,
  );
}

export interface EyeUniforms {
  /** Eye centre in head space: x = |x| of either eye, y = height. */
  uEyeCenter: { value: THREE.Vector2 };
  /** x: corner darkening amount, y: radius where it starts, z: radius where it is full (m). */
  uEyeCorner: { value: THREE.Vector3 };
  /** Upper-lid darkening amount (stand-in for the hidden lashes and lid shadow). */
  uEyeLid: { value: number };
}

export function patchEye(material: THREE.Material, uniforms: EyeUniforms) {
  patchOcclusion(
    material,
    "look-eye",
    uniforms as unknown as Record<string, THREE.IUniform>,
    /* glsl */ `
    uniform vec2 uEyeCenter;
    uniform vec3 uEyeCorner;
    uniform float uEyeLid;
    float lookOcclusion( vec3 p ) {
      vec2 q = vec2( abs( p.x ) - uEyeCenter.x, p.y - uEyeCenter.y );
      float r = length( q * vec2( 1.0, 1.4 ) );
      float o = 1.0 - uEyeCorner.x * smoothstep( uEyeCorner.y, uEyeCorner.z, r );
      return o * ( 1.0 - uEyeLid * smoothstep( 0.001, 0.009, q.y ) );
    }`,
  );
}
