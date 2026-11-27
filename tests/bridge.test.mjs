// Loopback test: start the bridge on random ports, connect a WebSocket source and a consumer,
// send LikenessFrames, and check the JSON re-broadcast and the VMC packets that arrive over UDP.
// Everything stays on 127.0.0.1.
import dgram from "node:dgram";
import WebSocket from "ws";
import { startBridge } from "../bridge/likeness-bridge.mjs";
import { frameToVmc, validateFrame } from "../bridge/vmc.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}
const near = (a, b, eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps);
const fmt = (a) => "[" + a.map((x) => x.toFixed(4)).join(", ") + "]";

// --- a tiny OSC decoder, independent of bridge/osc.mjs (strings, int32, float32, bundles)
function decode(buf, out = []) {
  const str = (o) => { let e = o; while (buf[e] !== 0) e++; return [buf.toString("utf8", o, e), (e + 4) & ~3]; };
  if (buf.toString("ascii", 0, 8) === "#bundle\0") {
    for (let o = 16; o < buf.length;) { const n = buf.readInt32BE(o); decode(buf.subarray(o + 4, o + 4 + n), out); o += 4 + n; }
    return out;
  }
  let [address, o] = str(0);
  let tags; [tags, o] = str(o);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === "i") { args.push(buf.readInt32BE(o)); o += 4; }
    else if (t === "f") { args.push(buf.readFloatBE(o)); o += 4; }
    else if (t === "s") { const [s, n] = str(o); args.push(s); o = n; }
    else throw new Error("tag " + t);
  }
  out.push({ address, tags: tags.slice(1), args });
  return out;
}

// --- test data
const deg = Math.PI / 180;
/** Rotation about a unit axis, [x, y, z, w]. */
const quat = (axis, angle) => [...axis.map((a) => a * Math.sin(angle / 2)), Math.cos(angle / 2)];

const ARKIT = (await import("../bridge/vmc.mjs")).ARKIT_BLENDSHAPES;
function blend(over = {}) {
  return Object.fromEntries(ARKIT.map((n) => [n, over[n] ?? 0]));
}

/**
 * A flat hand held out to the subject's side, palm down, fingers pointing away from the body, thumb
 * towards the camera: the VRM T-pose hand. Camera frame (x = subject's left), metres.
 * `curlIndex` bends the index PIP joint 90 degrees towards the palm.
 */
function tposeHand(side, curlIndex = false) {
  const s = side === "left" ? 1 : -1; // subject's left is +x
  const w = [0.5 * s, 0, -0.5];
  const at = (dx, dy, dz) => [w[0] + dx * s, w[1] + dy, w[2] + dz];
  const j = [w];
  for (let k = 1; k <= 4; k++) j.push(at(0.025 * k, 0, 0.025 * k)); // thumb at 45 deg towards the camera
  for (const dz of [0.02, 0, -0.02, -0.04]) {
    j.push(at(0.09, 0, dz), at(0.13, 0, dz));
    if (curlIndex && dz === 0.02) j.push(at(0.13, -0.025, dz), at(0.13, -0.045, dz));
    else j.push(at(0.155, 0, dz), at(0.175, 0, dz));
  }
  return { side, score: 0.9, joints: j };
}

const yaw = 30 * deg;
const frame = {
  v: 1,
  t: 1234.5,
  face: {
    // Subject turns their head 30 degrees to their own left (positive rotation about +y in the
    // right-handed camera frame takes the face direction +z towards +x, the subject's left).
    blendshapes: blend({ jawOpen: 0.5, eyeBlinkLeft: 1, eyeBlinkRight: 0.2, mouthSmileLeft: 0.9, mouthSmileRight: 0.9 }),
    head: { rotation: quat([0, 1, 0], yaw), position: [0.01, 0.02, -0.6] },
    calibrated: true,
  },
  hands: [tposeHand("left", true), tposeHand("right")],
};

// --- start the bridge and a UDP receiver
const udp = dgram.createSocket("udp4");
await new Promise((r) => udp.bind(0, "127.0.0.1", r));
const packets = [];
let onPacket = () => {};
udp.on("message", (b) => { packets.push(b); onPacket(); });

const logs = [];
const bridge = await startBridge({
  port: 0,
  host: "127.0.0.1",
  vmc: { host: "127.0.0.1", port: udp.address().port },
  quiet: true,
  err: (s) => logs.push(s),
  out: () => {},
});
const url = `ws://127.0.0.1:${bridge.port}`;
const connect = (opts) => new Promise((res, rej) => { const ws = new WebSocket(url, opts); ws.once("open", () => res(ws)); ws.once("error", rej); });

const consumer = await connect();
const received = [];
consumer.on("message", (d) => received.push(JSON.parse(d.toString())));
const source = await connect();

/** Sends a frame and waits for the VMC set (up to /VMC/Ext/Blend/Apply). */
async function sendAndCollect(ws, f) {
  packets.length = 0;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for VMC packets")), 2000);
    onPacket = () => {
      const msgs = packets.flatMap((p) => decode(p));
      if (msgs.some((m) => m.address === "/VMC/Ext/Blend/Apply")) { clearTimeout(timer); resolve(msgs); }
    };
  });
  ws.send(JSON.stringify(f));
  return done;
}

try {
  const msgs = await sendAndCollect(source, frame);
  const bone = (n) => msgs.find((m) => m.address === "/VMC/Ext/Bone/Pos" && m.args[0] === n);
  const val = (n) => msgs.find((m) => m.address === "/VMC/Ext/Blend/Val" && m.args[0] === n)?.args[1];

  check("packets <= 1500 bytes", packets.every((p) => p.length <= 1500), `${packets.length} packets`);
  const ok = msgs.find((m) => m.address === "/VMC/Ext/OK");
  check("/VMC/Ext/OK 1 3 0 1", ok && ok.tags === "iiii" && near(ok.args, [1, 3, 0, 1]));
  check("/VMC/Ext/T is a float", msgs.some((m) => m.address === "/VMC/Ext/T" && m.tags === "f"));
  const root = msgs.find((m) => m.address === "/VMC/Ext/Root/Pos");
  check("/VMC/Ext/Root/Pos root at origin", root && root.tags === "sfffffff" && root.args[0] === "root" && near(root.args.slice(1), [0, 0, 0, 0, 0, 0, 1]));
  check("Apply is the last message", msgs[msgs.length - 1].address === "/VMC/Ext/Blend/Apply");
  check("Bone/Pos type tags", bone("Head")?.tags === "sfffffff");

  // Coordinate conversion. Unity is left-handed with +x = the avatar's right, so turning to your own
  // left is a NEGATIVE rotation about Unity's y: q = (0, -sin(15deg), 0, cos(15deg)), split 30/70.
  const neck = bone("Neck").args.slice(4), head = bone("Head").args.slice(4);
  check("Neck = 30% of the yaw, negated y", near(neck, quat([0, -1, 0], 0.3 * yaw)), fmt(neck));
  check("Head = 70% of the yaw, negated y", near(head, quat([0, -1, 0], 0.7 * yaw)), fmt(head));

  // Blendshapes: PascalCase ARKit names by default, plus VRM presets.
  check("JawOpen = 0.5", Math.abs(val("JawOpen") - 0.5) < 1e-6, String(val("JawOpen")));
  check("EyeBlinkLeft = 1", val("EyeBlinkLeft") === 1);
  check("no camelCase duplicates by default", val("jawOpen") === undefined);
  check("all 52 ARKit names sent", msgs.filter((m) => m.address === "/VMC/Ext/Blend/Val").length === 52 + 17);
  check("Blink = shared part, Blink_L/R = remainder", near([val("Blink"), val("Blink_L"), val("Blink_R")], [0.2, 0.8, 0]),
    fmt([val("Blink"), val("Blink_L"), val("Blink_R")]));
  check("Joy from a big smile", val("Joy") > 0.8 && val("Fun") < 0.2, `Joy ${val("Joy")?.toFixed(2)}, Fun ${val("Fun")?.toFixed(2)}`);
  check("A from an open jaw", val("A") > 0.3, `A ${val("A")?.toFixed(2)}`);

  // Hands: a T-pose hand gives identity; the curled index PIP turns +90 degrees about Unity z
  // (left hand: fingers along -x, curling towards the palm, -y).
  const I = [0, 0, 0, 1];
  check("LeftHand at T-pose = identity", near(bone("LeftHand").args.slice(4), I, 1e-3), fmt(bone("LeftHand").args.slice(4)));
  check("RightHand at T-pose = identity", near(bone("RightHand").args.slice(4), I, 1e-3), fmt(bone("RightHand").args.slice(4)));
  check("LeftThumbProximal at rest = identity", near(bone("LeftThumbProximal").args.slice(4), I, 1e-3));
  check("LeftIndexProximal straight = identity", near(bone("LeftIndexProximal").args.slice(4), I, 1e-3));
  const pip = bone("LeftIndexIntermediate").args.slice(4);
  check("LeftIndexIntermediate curled 90 deg about +z", near(pip, quat([0, 0, 1], 90 * deg), 1e-3), fmt(pip));
  check("LeftIndexDistal follows (identity)", near(bone("LeftIndexDistal").args.slice(4), I, 1e-3));
  check("all 32 finger + 2 hand bones", msgs.filter((m) => m.address === "/VMC/Ext/Bone/Pos").length === 2 + 2 * 16);

  // JSON re-broadcast to the consumer (not echoed to the source).
  await new Promise((r) => setTimeout(r, 50));
  check("consumer got the frame as JSON", received.length === 1 && received[0].face.blendshapes.jawOpen === 0.5 && received[0].hands.length === 2);

  // Malformed frames are ignored, the bridge keeps going.
  source.send("{not json");
  source.send(JSON.stringify({ v: 2, t: 0, face: null, hands: [] }));
  source.send(JSON.stringify({ v: 1, t: 0, face: { blendshapes: {}, head: { rotation: [0, 0, 0], position: [0, 0, 0] } }, hands: [] }));
  await new Promise((r) => setTimeout(r, 50));
  check("malformed frames reported, not forwarded", received.length === 1 && logs.filter((l) => l.includes("malformed")).length === 3, `${logs.length} log lines`);

  // A newer source takes over; frames from the older one are then ignored while the newer is live.
  const source2 = await connect();
  const f2 = { ...frame, t: 2, face: { ...frame.face, blendshapes: blend({ jawOpen: 0.1 }) } };
  const msgs2 = await sendAndCollect(source2, f2);
  check("newer source is used", Math.abs(msgs2.find((m) => m.args[0] === "JawOpen").args[1] - 0.1) < 1e-6);
  received.length = 0;
  source.send(JSON.stringify(frame));
  await new Promise((r) => setTimeout(r, 50));
  check("older source ignored while the newer one is live", received.length === 0);
  source2.close();
  await new Promise((r) => setTimeout(r, 50));
  const msgs3 = await sendAndCollect(source, frame);
  check("older source resumes when the newer one leaves", Math.abs(msgs3.find((m) => m.args[0] === "JawOpen").args[1] - 0.5) < 1e-6);

  // Pages from other origins are refused; localhost pages are accepted.
  const refused = await connect({ headers: { Origin: "https://evil.example" } }).then((w) => { w.close(); return false; }, () => true);
  check("foreign origin refused", refused);
  const local = await connect({ headers: { Origin: "http://localhost:5173" } }).then((w) => { w.close(); return true; }, () => false);
  check("localhost origin accepted", local);
} catch (e) {
  check("loopback", false, e.stack);
}

// --- pure conversion checks (no sockets)
{
  const f = validateFrame(frame);
  const m = frameToVmc(f, { mirror: true });
  const bone = (n) => m.find((x) => x.address === "/VMC/Ext/Bone/Pos" && x.args[0] === n).args;
  const val = (n) => m.find((x) => x.address === "/VMC/Ext/Blend/Val" && x.args[0] === n)?.args[1];
  check("mirror: yaw sign kept (avatar turns like a reflection)", near(bone("Head").slice(4), quat([0, 1, 0], 0.7 * yaw)));
  check("mirror: Left/Right blendshapes swapped", val("EyeBlinkRight") === 1 && Math.abs(val("EyeBlinkLeft") - 0.2) < 1e-6 && Math.abs(val("Blink_R") - 0.8) < 1e-6);
  check("mirror: subject's left hand drives RightHand", near(bone("RightIndexIntermediate").slice(4), quat([0, 0, -1], 90 * deg), 1e-3),
    fmt(bone("RightIndexIntermediate").slice(4)));

  // Pitch: nodding down (+x rotation in the camera frame) is +x in Unity too (both axis and handedness flip).
  const nod = validateFrame({ ...frame, face: { ...frame.face, head: { rotation: quat([1, 0, 0], 20 * deg), position: [0, 0, -0.6] } } });
  const hq = frameToVmc(nod).find((x) => x.args[0] === "Head").args.slice(4);
  check("pitch: x component kept", near(hq, quat([1, 0, 0], 0.7 * 20 * deg)), fmt(hq));
  // Roll about z (camera axis) flips sign.
  const roll = validateFrame({ ...frame, face: { ...frame.face, head: { rotation: quat([0, 0, 1], 20 * deg), position: [0, 0, -0.6] } } });
  const rq = frameToVmc(roll).find((x) => x.args[0] === "Head").args.slice(4);
  check("roll: z component negated", near(rq, quat([0, 0, -1], 0.7 * 20 * deg)), fmt(rq));

  const both = frameToVmc(f, { blendCase: "both" }).filter((x) => x.address === "/VMC/Ext/Blend/Val").map((x) => x.args[0]);
  check("blendCase both sends JawOpen and jawOpen", both.includes("JawOpen") && both.includes("jawOpen"));
  const vrmOnly = frameToVmc(f, { blendshapes: "vrm" }).filter((x) => x.address === "/VMC/Ext/Blend/Val");
  check("blendshapes=vrm sends only the 17 presets", vrmOnly.length === 17);
  const noHands = frameToVmc(f, { hands: false }).filter((x) => x.address === "/VMC/Ext/Bone/Pos");
  check("hands off: only Neck and Head", noHands.length === 2);
  const rootState = {};
  frameToVmc(f, { rootMotion: true }, rootState);
  const moved = validateFrame({ ...frame, face: { ...frame.face, head: { ...frame.face.head, position: [0.11, 0.02, -0.5] } } });
  const rp = frameToVmc(moved, { rootMotion: true }, rootState).find((x) => x.address === "/VMC/Ext/Root/Pos").args.slice(1, 4);
  check("root motion: +x (subject's left) -> -x, towards camera -> +z", near(rp, [-0.1, 0, 0.1]), fmt(rp));
  const noFace = frameToVmc(validateFrame({ v: 1, t: 0, face: null, hands: [] }));
  check("no face: tracking status 0, no blendshapes", noFace[0].args[3].value === 0 && !noFace.some((x) => x.address.startsWith("/VMC/Ext/Blend")));
}

await bridge.close();
udp.close();
if (failures) {
  console.log(`${failures} bridge test(s) failed`);
  process.exit(1);
}
process.exit(0);
