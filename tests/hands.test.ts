import * as THREE from "three";
import {
  BONES, LANDMARK_JOINT, N_JOINTS, chiralityScore, estimateDepth, estimatePalm, palmCentroids, cameraPoints,
  subjectHandedness, toHandOutput, constrainFingers,
} from "../src/handMath.js";
import { makeRest, solvePose } from "../src/handRetarget.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${detail})`);
  if (!ok) failures++;
}

// A synthetic flat right hand in a right-handed frame (x right, y up, z towards the viewer),
// palm facing the viewer (+z), fingers up, thumb towards +x (the hand's radial side), metres.
function flatRightHand(): Float32Array {
  const p: number[] = [0, 0, 0]; // wrist
  for (const [x, y] of [[0.025, 0.02], [0.045, 0.04], [0.06, 0.06], [0.07, 0.08]]) p.push(x, y, 0.01); // thumb
  const xs = [0.025, 0, -0.02, -0.038], mcpY = [0.085, 0.09, 0.085, 0.075];
  for (let f = 0; f < 4; f++) {
    let y = mcpY[f];
    p.push(xs[f], y, 0);
    for (const dy of [0.04, 0.026, 0.018]) p.push(xs[f], (y += dy), 0); // PIP, DIP, tip
  }
  return Float32Array.from(p);
}

/** Model rest from landmarks: joints at the landmarks, metacarpals 1/4 of the way wrist -> MCP. */
function syntheticModel(lm: Float32Array) {
  const pos = new Float32Array(N_JOINTS * 3);
  LANDMARK_JOINT.forEach((j, l) => pos.set(lm.subarray(l * 3, l * 3 + 3), j * 3));
  [5, 10, 15, 20].forEach((j, f) => {
    const mcp = 5 + f * 4;
    for (let c = 0; c < 3; c++) pos[j * 3 + c] = lm[c] + 0.25 * (lm[mcp * 3 + c] - lm[c]);
  });
  // WebXR-style rest rotations: local -Z along the bone, +Y out of the back of the hand (-z here).
  const quat = new Float32Array(N_JOINTS * 4);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  BONES.forEach((b, j) => {
    const d = new THREE.Vector3().fromArray(lm, b.to * 3).sub(new THREE.Vector3().fromArray(lm, b.from * 3)).normalize();
    const zAxis = d.clone().negate();
    const y = new THREE.Vector3(0, 0, -1).addScaledVector(zAxis, -new THREE.Vector3(0, 0, -1).dot(zAxis)).normalize();
    const x = new THREE.Vector3().crossVectors(y, zAxis);
    q.setFromRotationMatrix(m.makeBasis(x, y, zAxis)).toArray(quat, j * 4);
  });
  return { pos, quat };
}

function transform(lm: Float32Array, f: (v: THREE.Vector3) => THREE.Vector3): Float32Array {
  const out = new Float32Array(lm.length), v = new THREE.Vector3();
  for (let i = 0; i < lm.length / 3; i++) f(v.fromArray(lm, i * 3)).toArray(out, i * 3);
  return out;
}

/** Angle between two rotations in degrees (atan2 form: accurate near zero, unlike acos of the dot). */
const angle = (a: THREE.Quaternion, b: THREE.Quaternion) => {
  const d = a.clone().invert().multiply(b);
  return (2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w)) * 180) / Math.PI;
};

const flat = flatRightHand();
const model = syntheticModel(flat);
const rest = makeRest(model.pos, model.quat);
const outPos = new Float32Array(N_JOINTS * 3), outQuat = new Float32Array(N_JOINTS * 4);

// 1. The rest landmarks reproduce the rest pose exactly (positions relative to the wrist).
{
  const k = solvePose(rest, flat, outPos, outQuat);
  let qErr = 0, pErr = 0;
  for (let j = 0; j < N_JOINTS; j++) {
    qErr = Math.max(qErr, angle(new THREE.Quaternion().fromArray(outQuat, j * 4), new THREE.Quaternion().fromArray(model.quat, j * 4)));
    for (let c = 0; c < 3; c++) pErr = Math.max(pErr, Math.abs(outPos[j * 3 + c] - (model.pos[j * 3 + c] - model.pos[c])));
  }
  check("rest pose is a fixed point", Math.abs(k - 1) < 1e-6 && qErr < 0.01 && pErr < 1e-6, `k ${k.toFixed(6)}, max rot err ${qErr.toFixed(4)} deg, max pos err ${pErr.toExponential(1)} m`);
}

// 2. A rigidly rotated, scaled hand: every bone turns by the same rotation and the scale is recovered.
{
  const R = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.7));
  const moved = transform(flat, (v) => v.applyQuaternion(R).multiplyScalar(1.15).add(new THREE.Vector3(0.2, -0.1, 0.3)));
  const k = solvePose(rest, moved, outPos, outQuat);
  let err = 0;
  for (let j = 0; j < N_JOINTS; j++) {
    const want = R.clone().multiply(new THREE.Quaternion().fromArray(model.quat, j * 4));
    err = Math.max(err, angle(new THREE.Quaternion().fromArray(outQuat, j * 4), want));
  }
  check("rigid rotation and scale", Math.abs(k - 1.15) < 1e-5 && err < 0.01, `k ${k.toFixed(5)}, max rot err ${err.toFixed(4)} deg`);
}

// 3. Curled fingers: each bone's local -Z points from its joint to the next landmark, +Y stays dorsal,
//    and forward kinematics puts the fingertips where the landmarks are (the model is the same hand).
{
  const curled = Float32Array.from(flat);
  for (let f = 0; f < 4; f++) {
    // Flex each finger joint by 50 degrees towards the palm (+z), about the x axis through the joint.
    const mcp = 5 + f * 4;
    for (let k = 0; k < 3; k++) {
      const pivot = new THREE.Vector3().fromArray(curled, (mcp + k) * 3);
      const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (50 * Math.PI) / 180);
      for (let l = mcp + k + 1; l <= mcp + 3; l++) {
        new THREE.Vector3().fromArray(curled, l * 3).sub(pivot).applyQuaternion(rot).add(pivot).toArray(curled, l * 3);
      }
    }
  }
  solvePose(rest, curled, outPos, outQuat);
  let dirErr = 0, dorsalErr = 0, tipErr = 0;
  BONES.forEach((b, j) => {
    const q = new THREE.Quaternion().fromArray(outQuat, j * 4);
    const negZ = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const d = new THREE.Vector3().fromArray(curled, b.to * 3).sub(new THREE.Vector3().fromArray(curled, b.from * 3)).normalize();
    dirErr = Math.max(dirErr, (Math.atan2(negZ.clone().cross(d).length(), negZ.dot(d)) * 180) / Math.PI);
    if (b.ref === "lateral" && b.from !== 0) {
      // Flexion is about x, so the bone's x axis stays the palm's lateral axis.
      const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      dorsalErr = Math.max(dorsalErr, (Math.atan2(Math.hypot(x.y, x.z), Math.abs(x.x)) * 180) / Math.PI);
    }
  });
  for (const tip of [8, 12, 16, 20]) {
    const j = LANDMARK_JOINT[tip];
    const got = new THREE.Vector3().fromArray(outPos, j * 3);
    const want = new THREE.Vector3().fromArray(curled, tip * 3).sub(new THREE.Vector3().fromArray(curled, 0));
    tipErr = Math.max(tipErr, got.distanceTo(want));
  }
  check("curled fingers: bone axes follow the landmarks", dirErr < 0.01 && dorsalErr < 0.01 && tipErr < 1e-5,
    `max -Z err ${dirErr.toFixed(4)} deg, max twist err ${dorsalErr.toFixed(4)} deg, max tip err ${tipErr.toExponential(1)} m`);
}

// 4. Depth: a hand 0.45 m away, 12 cm off-axis, tilted 55 degrees, seen by a 900 px focal camera.
{
  const W = 1280, H = 720, f = 900, Z = 0.45;
  // World landmarks in MediaPipe camera axes (x right, y down, z away): flip our y and z.
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.96, 0.3, 0.2));
  const ours = transform(flat, (v) => v.applyQuaternion(tilt));
  const world = transform(ours, (v) => v.set(v.x, -v.y, -v.z));
  const cx = 0.12, cy = -0.05; // palm offset from the optical axis (m), y up
  const image = new Float32Array(63);
  const c = palmCentroids(new Float32Array(63), world, W, H);
  for (let i = 0; i < 21; i++) {
    const X = cx + world[i * 3] - c.wx, Yd = -cy + world[i * 3 + 1] - c.wy, Zi = Z + world[i * 3 + 2] - c.wz;
    image[i * 3] = (W / 2 + (f * X) / Zi) / W; // perspective projection, y down
    image[i * 3 + 1] = (H / 2 + (f * Yd) / Zi) / H;
  }
  const z = estimateDepth(image, world, W, H, f);
  check("depth from metric hand size vs pixels", Math.abs(z - Z) / Z < 1e-3, `estimated ${z.toFixed(4)} m, true ${Z} m`);

  const palm = estimatePalm(image, world, W, H, f)!;
  const pts = cameraPoints(world, c, palm.X, palm.Y, palm.Z, new Float32Array(63));
  let jointErr = 0;
  for (let i = 0; i < 21; i++) {
    const want = [cx + world[i * 3] - c.wx, cy - (world[i * 3 + 1] - c.wy), Z + world[i * 3 + 2] - c.wz];
    jointErr = Math.max(jointErr, Math.hypot(pts[i * 3] - want[0], pts[i * 3 + 1] - want[1], pts[i * 3 + 2] - want[2]));
  }
  check("palm placement", Math.hypot(palm.X - cx, palm.Y - cy) < 1e-4 && jointErr < 1e-4,
    `palm at (${palm.X.toFixed(4)}, ${palm.Y.toFixed(4)}) m, true (${cx}, ${cy}); max joint err ${jointErr.toExponential(1)} m`);

  // Same hand with the 2D ratio Z = f * L_world / L_px over the palm: biased by tilt and off-axis parallax.
  let lw = 0, lp = 0;
  for (const [i, j] of [[0, 5], [0, 9], [0, 13], [0, 17]]) {
    lw += Math.hypot(world[i * 3] - world[j * 3], world[i * 3 + 1] - world[j * 3 + 1], world[i * 3 + 2] - world[j * 3 + 2]);
    lp += Math.hypot((image[i * 3] - image[j * 3]) * W, (image[i * 3 + 1] - image[j * 3 + 1]) * H);
  }
  console.log(`     (simple ratio f*L3d/Lpx would say ${((f * lw) / lp).toFixed(3)} m)`);

  const out = toHandOutput({ handedness: "Left", score: 0.9, image, world }, { videoWidth: W, videoHeight: H, focalPx: f })!;
  check("toHandOutput", out.side === "left" && out.joints.length === 21 && Math.abs(out.joints[0][2] + pts[2]) < 1e-6 && out.joints[0][2] < 0,
    `wrist at (${out.joints[0].map((v) => v.toFixed(3)).join(", ")}) m, z towards the camera`);

  // A collapsed projection (every landmark on one pixel) cannot be placed.
  const dot = new Float32Array(63).fill(0.5);
  check("degenerate projection gives no depth", Number.isNaN(estimateDepth(dot, world, W, H, f)), "NaN as expected");
}

// 5. Handedness. MediaPipe's own test fixture thumb_up_landmarks.pbtxt (mediapipe/tasks/testdata/vision,
//    Apache 2.0) expects "Right" for thumb_up.jpg, an unmirrored photo of a right hand. Its landmarks'
//    geometry says right-handed too, so the label is the chirality of the hand as seen in the image.
{
  const thumbUpImage = [0.6387502, 0.67134184, -3.4e-7, 0.634891, 0.53670025, -0.06968865, 0.5746676, 0.41283816, -0.09383486, 0.49967948, 0.32550922, -0.10799447, 0.47362617, 0.25102285, -0.10590933, 0.40749234, 0.47130388, -0.04694611, 0.3372087, 0.46742308, -0.0997342, 0.4418445, 0.50960016, -0.111206524, 0.48056933, 0.5187666, -0.11022365, 0.39218128, 0.5495232, -0.028925514, 0.34047198, 0.55610204, -0.08213869, 0.46152583, 0.58310646, -0.08393028, 0.47058716, 0.56413835, -0.078857616, 0.39237642, 0.61864823, -0.022026168, 0.34304678, 0.62800515, -0.08132204, 0.45004016, 0.64300805, -0.06211204, 0.4640005, 0.6221539, -0.038953774, 0.39231628, 0.68187976, -0.020164328, 0.35785866, 0.6985842, -0.052247807, 0.42698768, 0.69892275, -0.037642766, 0.44422707, 0.6876204, -0.02034688];
  const thumbUpWorld = [0.06753889, 0.031051591, 0.05541924, 0.06327636, -0.003913434, 0.02125023, 0.05469646, -0.038668767, 0.01118496, 0.03557241, -0.06865983, 0.0029562893, 0.019069858, -0.08740239, 0.007222481, 0.0044852756, -0.02772763, -0.004234833, -0.0031203926, -0.024173645, -0.033932913, 0.0080217365, -0.018939625, -0.032623816, 0.025537387, -0.014517117, -0.004398854, -0.004470923, -0.0040212176, 0.0025033879, -0.010845158, -0.0031857258, -0.036282137, 0.016729971, 0.0028876318, -0.036264844, 0.019928008, -0.0032422952, 0.004380459, -0.005686749, 0.017101247, 0.0036791638, -0.010514952, 0.017355483, -0.02882688, 0.014503509, 0.019414417, -0.026207235, 0.0211232, 0.014327417, 0.0011467658, 0.0011399705, 0.043651186, 0.0068390737, -0.010388309, 0.03904784, -0.015677728, 0.006957108, 0.03613425, -0.028704688, 0.012793289, 0.03930679, -0.012465539];
  const mirrorX = (p: number[]) => p.map((v, i) => (i % 3 === 0 ? -v : v));
  const sImg = chiralityScore(thumbUpImage), sWorld = chiralityScore(thumbUpWorld);
  check("fixture 'Right' hand is right-handed", sImg > 0 && sWorld > 0 && chiralityScore(mirrorX(thumbUpWorld)) < 0,
    `image ${sImg.toFixed(3)}, world ${sWorld.toFixed(3)}, mirrored ${chiralityScore(mirrorX(thumbUpWorld)).toFixed(3)}`);
  // Our synthetic right hand with curled fingers, in our y-up frame, and in MediaPipe's y-down frame.
  const curled = transform(flat, (v) => v);
  for (const tip of [8, 12, 16, 20]) curled[tip * 3 + 2] += 0.04;
  const mpFrame = transform(curled, (v) => v.set(v.x, -v.y, -v.z));
  check("chirality is frame-independent", chiralityScore(curled) > 0 && chiralityScore(mpFrame) > 0,
    `ours ${chiralityScore(curled).toFixed(3)}, MediaPipe axes ${chiralityScore(mpFrame).toFixed(3)}`);
  check("label mapping", subjectHandedness("Right") === "Right" && subjectHandedness("left") === "Left" &&
    subjectHandedness("Right", true) === "Left" && subjectHandedness("?") === null, "unmirrored input keeps the label");
}

// --- anatomical finger constraints ------------------------------------------------------------
{
  const dist = (p: Float32Array, a: number, b: number) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  // A valid pose (fingers curled 50 deg per joint in the bending plane) must come back nearly unchanged.
  const curled = Float32Array.from(flat);
  for (const [m, p1, d, t] of [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    const base = new THREE.Vector3().fromArray(curled, m * 3);
    let dir = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3().fromArray(curled, p1 * 3), ang = 0;
    for (const [j, l] of [[d, dist(flat, p1, d)], [t, dist(flat, d, t)]] as [number, number][]) {
      ang += 0.5;
      dir = new THREE.Vector3(0, Math.cos(ang), Math.sin(ang));
      pos = pos.clone().addScaledVector(dir, l);
      pos.toArray(curled, j * 3);
    }
    void base;
  }
  const before = Float32Array.from(curled);
  constrainFingers(curled);
  let maxLenErr = 0;
  for (const [a, b] of [[6, 7], [7, 8], [10, 11], [11, 12]]) maxLenErr = Math.max(maxLenErr, Math.abs(dist(curled, a, b) - dist(before, a, b)));
  check("constrainFingers keeps segment lengths", maxLenErr < 1e-6, `max err ${maxLenErr.toExponential(1)} m`);
  // A sideways kink at the index PIP is removed: the distal segments end up in the bending plane (x stays at the finger's x).
  const kinked = Float32Array.from(flat);
  kinked[7 * 3] += 0.015; kinked[8 * 3] += 0.03; // index DIP/TIP pushed sideways
  constrainFingers(kinked);
  const sideways = Math.max(Math.abs(kinked[7 * 3] - flat[6 * 3]), Math.abs(kinked[8 * 3] - flat[6 * 3]));
  check("constrainFingers removes sideways kinks", sideways < 1e-3, `max sideways offset ${(sideways * 1000).toFixed(2)} mm`);
  // Hyperextension (tip bent backwards, away from the palm side) is straightened.
  const hyper = Float32Array.from(flat);
  for (const [p1, d, t] of [[10, 11, 12]]) { hyper[d * 3 + 2] -= 0.01; hyper[t * 3 + 2] -= 0.025; void p1; }
  hyper[14 * 3 + 2] += 0.01; hyper[15 * 3 + 2] += 0.02; hyper[16 * 3 + 2] += 0.03; // ring curls the other way: defines "palm side"
  constrainFingers(hyper);
  const bentBack = Math.abs(hyper[12 * 3 + 2]) > 0.02;
  check("constrainFingers limits backward bends", !bentBack || Math.abs(hyper[12 * 3 + 2]) < 0.025, `middle tip z ${(hyper[12 * 3 + 2] * 1000).toFixed(1)} mm`);
}

if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
