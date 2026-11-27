// LikenessTracker lifecycle (start/stop races, stream ownership, lastProjection) with a fake DOM,
// a fake camera and a fake MediaPipe face tracker. No browser needed. (tracking.ts touches the DOM
// only when a tracker is constructed, so the fakes below can be installed after the imports.)
import { LikenessTracker } from "../src/tracking.js";
import { canonicalFace, trackFrame, loadLiteModel } from "./synthetic.js";

class FakeTrack {
  stopped = false;
  stop() { this.stopped = true; }
}
class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks() { return this.tracks; }
  get live() { return this.tracks.every((t) => !t.stopped); }
}
class FakeVideo {
  muted = false;
  playsInline = false;
  autoplay = false;
  dataset: Record<string, string> = {};
  srcObject: unknown = null;
  src = "";
  paused = true;
  readyState = 4;
  videoWidth = 1280;
  videoHeight = 720;
  currentTime = 0;
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  requestVideoFrameCallback() { return 1; }
  cancelVideoFrameCallback() {}
}

// getUserMedia resolves only when the test says so, to provoke races.
const pending: ((s: FakeStream) => void)[] = [];
const g = globalThis as Record<string, unknown>;
g.MediaStream = FakeStream;
g.HTMLVideoElement = FakeVideo;
g.document = { createElement: () => new FakeVideo() };
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => pending.push(resolve)) } },
});


let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

let faceOut: ReturnType<typeof trackFrame> | null = null;
const fakeFace = { detect: () => faceOut, close() {} };
const Ctor = LikenessTracker as unknown as new (face: unknown, lm: unknown, opts: object) => LikenessTracker;
const make = () => new Ctor(fakeFace, loadLiteModel(), {});
const settle = (p: Promise<void>) => p.then(() => "resolved", (e: Error) => e.name);

async function main() {
  // 1. stop() while the camera is still opening: the late stream is released, start() rejects.
  {
    const t = make();
    const p = settle(t.start());
    await tick();
    t.stop();
    const s = new FakeStream();
    pending.shift()!(s);
    const r = await p;
    check("stop() during getUserMedia releases the late camera", !s.live && !t.isRunning && r === "AbortError", `start() -> ${r}`);
  }

  // 2. Two overlapping start() calls: the newer one wins, the older camera is released.
  {
    const t = make();
    const errors: Error[] = [];
    t.on("error", (e: Error) => errors.push(e));
    const p1 = settle(t.start());
    await tick();
    const p2 = settle(t.start());
    await tick();
    const s1 = new FakeStream(), s2 = new FakeStream();
    const [resolve1, resolve2] = pending.splice(0, 2);
    resolve2(s2);
    await tick();
    resolve1(s1);
    const [r1, r2] = await Promise.all([p1, p2]);
    check("overlapping start(): older camera released, newer one kept", !s1.live && s2.live && t.isRunning,
      `older ${r1}, newer ${r2}`);
    check("a superseded start() is not reported as an error event", errors.length === 0, `${errors.length} error event(s)`);
    t.stop();
    check("stop() releases the camera the tracker opened", !s2.live);
  }

  // 3. A caller's MediaStream: stop() detaches it from the hidden <video> but never stops its tracks.
  {
    const t = make();
    const s = new FakeStream();
    await t.start(s as unknown as MediaStream);
    const v = t.video as unknown as FakeVideo;
    check("caller's stream plays in the tracker's own video", v.srcObject === s && !v.paused && t.isRunning);
    t.stop();
    check("stop(): caller's stream detached and video paused, tracks left alone", v.srcObject === null && v.paused && s.live && !t.isRunning);
  }

  // 4. lastProjection follows the latest frame: null once the face is lost.
  {
    const t = make();
    const video = new FakeVideo() as unknown as HTMLVideoElement;
    faceOut = trackFrame(canonicalFace());
    t.process(video, 10);
    const withFace = t.lastProjection !== null && t.lastFrame?.face !== null;
    faceOut = null;
    t.process(video, 20);
    check("lastProjection is null when the latest frame has no face", withFace && t.lastProjection === null && t.lastFrame?.face === null);
  }

  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
}

void main();
