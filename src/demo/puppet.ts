import * as THREE from "three";
import { LikenessAvatar } from "../avatar.js";
import type { HandOutput, LikenessFrame } from "../frame.js";

type Vec3 = [number, number, number];

/** Per-finger joint flexion (MCP, PIP, DIP) in radians and sideways spread, index..pinky. */
interface HandPose {
  flex: [number, number, number][];
  spread: number[];
  /** 0 = thumb out to the side, 1 = folded across the palm. */
  thumbTuck: number;
}

export const OPEN: HandPose = {
  flex: [[0.12, 0.15, 0.08], [0.1, 0.14, 0.08], [0.12, 0.16, 0.1], [0.15, 0.18, 0.1]],
  spread: [0.16, 0.03, -0.1, -0.22],
  thumbTuck: 0,
};
export const PEACE: HandPose = {
  flex: [[0.05, 0.06, 0.04], [0.05, 0.06, 0.04], [1.45, 1.6, 0.9], [1.45, 1.6, 0.9]],
  spread: [0.24, -0.1, -0.05, -0.12],
  thumbTuck: 1,
};

function mixPose(a: HandPose, b: HandPose, t: number): HandPose {
  const m = (x: number, y: number) => x + (y - x) * t;
  return {
    flex: a.flex.map((f, i) => [m(f[0], b.flex[i][0]), m(f[1], b.flex[i][1]), m(f[2], b.flex[i][2])] as [number, number, number]),
    spread: a.spread.map((v, i) => m(v, b.spread[i])),
    thumbTuck: m(a.thumbTuck, b.thumbTuck),
  };
}

/**
 * A synthetic hand in the camera frame (x = image right, y up, z towards the camera, metres):
 * palm facing the camera, fingers up, thumb towards the face. Fingers bend towards the camera
 * (the palm side) with anatomical per-joint angles, so curled fingers fold like a real hand.
 */
export function syntheticHand(side: "left" | "right", wrist: Vec3, pose: HandPose): HandOutput {
  const sx = side === "right" ? 1 : -1; // the subject's right hand sits at image-left; its thumb points to +x
  const at = (x: number, y: number, z: number): Vec3 => [wrist[0] + sx * x, wrist[1] + y, wrist[2] + z];
  const joints: Vec3[] = [wrist];

  // Thumb: out to the side when open, folded across the palm (in front of ring/middle) when tucked.
  const tuck = pose.thumbTuck;
  const thumbOpen: Vec3[] = [[0.025, 0.02, 0.01], [0.045, 0.04, 0.012], [0.06, 0.062, 0.014], [0.07, 0.083, 0.015]];
  const thumbTucked: Vec3[] = [[0.025, 0.02, 0.012], [0.035, 0.042, 0.03], [0.018, 0.058, 0.042], [-0.004, 0.064, 0.044]];
  for (let j = 0; j < 4; j++) {
    const o = thumbOpen[j], c = thumbTucked[j];
    joints.push(at(o[0] + (c[0] - o[0]) * tuck, o[1] + (c[1] - o[1]) * tuck, o[2] + (c[2] - o[2]) * tuck));
  }

  // Fingers: MCP base on the palm, then three segments that bend towards the camera.
  const base: [number, number][] = [[0.025, 0.085], [0.0, 0.09], [-0.02, 0.085], [-0.038, 0.075]];
  const lengths = [[0.04, 0.025, 0.02], [0.044, 0.028, 0.021], [0.041, 0.027, 0.02], [0.032, 0.02, 0.018]];
  for (let f = 0; f < 4; f++) {
    let x = base[f][0], y = base[f][1], z = 0, bend = 0;
    joints.push(at(x, y, z));
    const sp = pose.spread[f];
    for (let k = 0; k < 3; k++) {
      bend += pose.flex[f][k];
      const len = lengths[f][k];
      const along = len * Math.cos(bend); // in the finger's (spread) direction within the palm plane
      x += along * Math.sin(sp);
      y += along * Math.cos(sp);
      z += len * Math.sin(bend);
      joints.push(at(x, y, z));
    }
  }
  return { side, score: 1, joints };
}

/**
 * "Try without a camera": an off-screen copy of the built-in avatar, animated
 * with talking, smiles, blinks, head motion and two hands (open palm and peace sign), rendered at 1280x720 and
 * returned as a camera-like MediaStream. The real tracker then tracks it, so the
 * whole pipeline runs exactly as it would on a webcam.
 */
export async function createPuppetStream(): Promise<{ stream: MediaStream; stop(): void }> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none";
  document.body.appendChild(host);
  const puppet = await LikenessAvatar.create({ container: host, mirror: false, orbit: false, maxPixelRatio: 1 });
  puppet.renderer.setPixelRatio(2); // 1280x720
  const names = puppet.model.expressionNames;
  const idx = (n: string) => names.indexOf(n);
  const w = new Float32Array(names.length);
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  const hands: LikenessFrame = { v: 1, t: 0, face: null, hands: [] };
  puppet.setFraming("upper-body"); // room for the hands at chest height in the fake camera image
  const t0 = performance.now();
  const off = puppet.onRender(() => {
    const t = (performance.now() - t0) / 1000;
    w.fill(0);
    const talk = Math.max(0, Math.sin(t * 2 * Math.PI * 4.2)) * (0.55 + 0.45 * Math.sin(t * 1.1));
    w[idx("jawOpen")] = 0.3 * talk;
    w[idx("mouthLowerDown_L")] = w[idx("mouthLowerDown_R")] = 0.45 * talk;
    const smile = Math.max(0, Math.sin(t * 0.6 - 1));
    w[idx("mouthSmile_L")] = w[idx("mouthSmile_R")] = 0.75 * smile;
    w[idx("cheekSquint_L")] = w[idx("cheekSquint_R")] = 0.4 * smile;
    w[idx("eyeBlink_L")] = w[idx("eyeBlink_R")] = t % 3.3 < 0.14 ? 1 : 0;
    w[idx("browInnerUp_L")] = w[idx("browInnerUp_R")] = 0.5 * Math.max(0, Math.sin(t * 0.45 + 2));
    puppet.setExpressionWeights(w);
    puppet.setHeadRotation(q.setFromEuler(e.set(0.12 * Math.sin(t * 0.43), 0.35 * Math.sin(t * 0.55), 0.05 * Math.sin(t * 0.31), "YXZ")));
    // Both hands: a relaxed open hand easing into a peace sign and back, out of phase.
    // Hold each pose (~2.5 s), with a ~1 s transition in between.
    const phase = (p: number) => {
      const c = Math.min(1, Math.max(0, (0.5 - 0.5 * Math.cos(t * 0.8 + p) - 0.3) / 0.4));
      return c * c * (3 - 2 * c);
    };
    hands.hands = [
      // Chest height, shoulder-width apart and a little in front of the body: a natural "presenting" pose.
      syntheticHand("right", [-0.24 + 0.015 * Math.sin(t * 1.3), -0.3 + 0.02 * Math.sin(t * 0.9), -0.42], mixPose(OPEN, PEACE, phase(0))),
      syntheticHand("left", [0.24 + 0.015 * Math.sin(t * 1.1 + 1), -0.3 + 0.02 * Math.sin(t * 0.8 + 2), -0.42], mixPose(OPEN, PEACE, phase(Math.PI))),
    ];
    hands.t = t * 1000;
    puppet.apply(hands);
  });
  const stream = puppet.renderer.domElement.captureStream(30);
  return {
    stream,
    stop() {
      off();
      stream.getTracks().forEach((tr) => tr.stop());
      puppet.dispose();
      host.remove();
    },
  };
}
