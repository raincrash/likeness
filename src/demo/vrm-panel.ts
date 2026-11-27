import * as THREE from "three";
import { VrmAvatar } from "../vrm.js";
import type { LikenessAvatar } from "../avatar.js";
import type { LikenessFrame } from "../frame.js";

/** The demo's "Load VRM" controls: swaps the built-in head for the user's VRM and drives it. */
export function setupVrm(avatar: LikenessAvatar, mirror: HTMLInputElement) {
  const file = document.getElementById("vrm-file") as HTMLInputElement;
  const clear = document.getElementById("btn-vrm-clear") as HTMLButtonElement;
  const info = document.getElementById("vrm-info") as HTMLElement;
  let vrm: VrmAvatar | null = null;
  let lastT = 0;
  let unsubscribe: (() => void) | null = null;
  const holder = new THREE.Group();
  const headPos = new THREE.Vector3();

  // VRM's MToon materials add every directional light at full strength and ignore the
  // environment map, so the studio rig would wash them out. Swap to a simple VRM-style
  // key + ambient while a VRM is shown (see docs/vrm.md).
  const saved: [THREE.Light, number][] = [];
  const vrmKey = new THREE.DirectionalLight(0xffffff, Math.PI * 0.8);
  vrmKey.position.set(0.5, 1, 1.5);
  const vrmAmbient = new THREE.AmbientLight(0xffffff, Math.PI * 0.2);
  function vrmLighting(on: boolean) {
    if (on && !saved.length) {
      avatar.scene.traverse((o) => {
        const l = o as THREE.Light;
        if (l.isLight) { saved.push([l, l.intensity]); l.intensity = 0; }
      });
      avatar.scene.add(vrmKey, vrmAmbient);
    } else if (!on && saved.length) {
      saved.splice(0).forEach(([l, i]) => (l.intensity = i));
      vrmKey.removeFromParent();
      vrmAmbient.removeFromParent();
    }
  }

  async function load(source: File | string) {
    const name = typeof source === "string" ? source.split("/").pop()! : source.name;
    info.textContent = `Loading ${name}…`;
    try {
      const next = await VrmAvatar.load(source);
      unload();
      vrm = next;
      vrm.scene.traverse((o) => {
        const mats = (o as THREE.Mesh).material;
        for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) if ((m as { isMToonMaterial?: boolean }).isMToonMaterial) m.toneMapped = false;
      });
      holder.add(vrm.scene);
      vrmLighting(true);
      avatar.setCustomAvatar(holder);
      // Frame the head like the built-in one: put the head bone at the origin.
      vrm.scene.updateMatrixWorld(true);
      vrm.getHeadPosition(headPos);
      vrm.scene.position.sub(headPos);
      unsubscribe = avatar.onRender((dt) => vrm?.update(dt));
      clear.disabled = false;
      const m = vrm.meta;
      info.innerHTML = `<strong>${escape(m.title || name)}</strong> by ${escape(m.author || "unknown")} · VRM ${m.version}` +
        `${vrm.perfectSync ? " · perfect sync" : ""}<br/>Licence: ${escape(m.license || "not stated")}`;
    } catch (err) {
      info.textContent = `Could not load that file: ${(err as Error).message}`;
    }
  }

  function unload() {
    unsubscribe?.();
    unsubscribe = null;
    vrm?.dispose();
    vrm = null;
    avatar.setCustomAvatar(null);
    vrmLighting(false);
    clear.disabled = true;
  }

  file.addEventListener("change", () => file.files?.[0] && load(file.files[0]));
  document.getElementById("btn-vrm-sample")?.addEventListener("click", () => load(`${import.meta.env.BASE_URL}avatars/VRM1_Constraint_Twist_Sample.vrm`));
  clear.addEventListener("click", () => {
    unload();
    info.textContent = "";
  });

  return {
    get active() {
      return !!vrm;
    },
    apply(frame: LikenessFrame) {
      // dt between tracked frames (frame.t is in ms), clamped so pauses don't jump the arm fade.
      const dt = lastT ? Math.min(0.1, Math.max(0, (frame.t - lastT) / 1000)) : 1 / 30;
      lastT = frame.t;
      vrm?.apply(frame, dt, { mirror: mirror.checked });
    },
    load,
    unload,
  };
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
