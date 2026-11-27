// The likeness demo app: a UI around the library (LikenessTracker + LikenessAvatar + StreamClient).
import { LikenessTracker } from "../tracking.js";
import { LikenessAvatar } from "../avatar.js";
import { StreamClient } from "../stream.js";
import { ARKIT_BLENDSHAPES, type LikenessFrame } from "../frame.js";
import { setupVrm } from "./vrm-panel.js";
import { createPuppetStream } from "./puppet.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const ui = {
  stage: $("stage"),
  video: $<HTMLVideoElement>("video"),
  overlay: $<HTMLCanvasElement>("overlay-canvas"),
  pip: $("pip"),
  welcome: $("welcome"),
  toast: $("toast"),
  chips: { camera: $("chip-camera"), face: $("chip-face"), hands: $("chip-hands"), stream: $("chip-stream"), fps: $("chip-fps") },
  btn: {
    camera: $<HTMLButtonElement>("btn-camera"),
    welcomeStart: $<HTMLButtonElement>("btn-welcome-start"),
    scan: $<HTMLButtonElement>("btn-scan"),
    record: $<HTMLButtonElement>("btn-record"),
    stage: $<HTMLButtonElement>("btn-stage"),
    panel: $<HTMLButtonElement>("btn-panel"),
    calibrate: $<HTMLButtonElement>("btn-calibrate"),
    stream: $<HTMLButtonElement>("btn-stream"),
    downloadTexture: $<HTMLButtonElement>("btn-download-texture"),
    clearScan: $<HTMLButtonElement>("btn-clear-scan"),
    randomIdentity: $<HTMLButtonElement>("btn-random-identity"),
    resetIdentity: $<HTMLButtonElement>("btn-reset-identity"),
  },
  opt: {
    mirror: $<HTMLInputElement>("opt-mirror"),
    wireframe: $<HTMLInputElement>("opt-wireframe"),
    background: $<HTMLSelectElement>("opt-background"),
    hands: $<HTMLInputElement>("opt-hands"),
    lipsync: $<HTMLInputElement>("opt-lipsync"),
    mic: $<HTMLInputElement>("opt-mic"),
    refine: $<HTMLInputElement>("opt-refine"),
    pose: $<HTMLInputElement>("opt-pose"),
    overlay: $<HTMLInputElement>("opt-overlay"),
    preview: $<HTMLInputElement>("opt-preview"),
  },
  videoFile: $<HTMLInputElement>("video-file"),
  streamUrl: $<HTMLInputElement>("stream-url"),
  streamInfo: $("stream-info"),
  framePreview: $("frame-preview"),
  exprBars: $("expr-bars"),
  perf: $("perf"),
  debugStatus: $("debug-status"),
  scanOverlay: $("scan-overlay"),
  scanRing: document.getElementById("scan-ring") as unknown as SVGCircleElement,
  scanMessage: $("scan-message"),
};

let toastTimer = 0;
function toast(html: string, error = false, ms = 6000) {
  ui.toast.innerHTML = html;
  ui.toast.classList.toggle("error", error);
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ui.toast.hidden = true), ms);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function setChip(el: HTMLElement, state: "on" | "off" | "wait", text?: string) {
  el.dataset.state = state;
  if (text) el.textContent = text;
}

// --- setup --------------------------------------------------------------------------

const [tracker, avatar] = await Promise.all([
  LikenessTracker.create({ hands: true, lipSync: true }),
  LikenessAvatar.create({ container: ui.stage, background: params.get("bg") ?? "studio" }),
]).catch((err: Error) => {
  toast(`<strong>Failed to load:</strong> ${escapeHtml(err.message)}`, true, 1e9);
  throw err;
});

/** ?bridge=… may only point at this machine: a shared link must not be able to send your tracking elsewhere. */
function loopbackBridge(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return /^wss?:$/.test(u.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}
const queryBridge = loopbackBridge(params.get("bridge"));
if (params.get("bridge") && !queryBridge) toast("Ignored ?bridge=: only localhost bridges can be set from a link. Use the Stream tab to connect elsewhere.", true);
if (queryBridge) ui.streamUrl.value = queryBridge;
let stream = new StreamClient(ui.streamUrl.value);
const vrm = setupVrm(avatar, ui.opt.mirror);

let lastFrame: LikenessFrame | null = null;
let frames = 0, fpsT = performance.now();

tracker.on("frame", (f: LikenessFrame) => {
  lastFrame = f;
  frames++;
  if (!ui.opt.pose.checked && f.face) f = { ...f, face: { ...f.face, head: { ...f.face.head, rotation: [0, 0, 0, 1] } } };
  if (vrm.active) vrm.apply(f);
  else avatar.apply(f);
  stream.send(f);
});

// --- camera -------------------------------------------------------------------------

let puppet: Awaited<ReturnType<typeof createPuppetStream>> | null = null;
let fileVideo: HTMLVideoElement | null = null;

/** Stops the demo face and the video file (and revokes its object URL), except `keep`. */
function releaseSources(keep?: unknown) {
  if (puppet && puppet.stream !== keep) {
    puppet.stop();
    puppet = null;
  }
  if (fileVideo && fileVideo !== keep) {
    fileVideo.pause();
    URL.revokeObjectURL(fileVideo.src);
    fileVideo.removeAttribute("src");
    fileVideo.load();
    fileVideo = null;
  }
}

let startSeq = 0; // bumped by start() and stop(): a superseded start() must not touch the UI or sources

async function start(source?: Parameters<LikenessTracker["start"]>[0]) {
  const seq = ++startSeq;
  releaseSources(source);
  try {
    setChip(ui.chips.camera, "wait", "camera…");
    await tracker.start(source ?? { camera: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } });
    const v = tracker.video;
    ui.video.srcObject = v.srcObject;
    if (!v.srcObject) ui.video.src = v.src;
    await ui.video.play().catch(() => {});
    if (seq !== startSeq) return;
    ui.welcome.hidden = true;
    ui.pip.hidden = !ui.opt.preview.checked;
    ui.btn.camera.textContent = "Stop camera";
    ui.btn.camera.classList.remove("primary");
    ui.btn.scan.disabled = ui.btn.record.disabled = false;
    setChip(ui.chips.camera, "on", "camera");
  } catch (err) {
    if (seq !== startSeq) return; // superseded by a newer start() or by stop()
    releaseSources();
    setChip(ui.chips.camera, "off", "camera");
    toast(`<strong>Could not start the camera:</strong> ${escapeHtml((err as Error).message)}`, true);
  }
}

function stop() {
  startSeq++;
  tracker.stop();
  releaseSources();
  ui.video.srcObject = null;
  ui.video.removeAttribute("src");
  ui.pip.hidden = true;
  ui.btn.camera.textContent = "Start camera";
  ui.btn.camera.classList.add("primary");
  ui.btn.scan.disabled = ui.btn.record.disabled = true;
  setChip(ui.chips.camera, "off");
  setChip(ui.chips.face, "off");
  lastFrame = null;
}

ui.btn.camera.addEventListener("click", () => (tracker.isRunning ? stop() : start()));
ui.btn.welcomeStart.addEventListener("click", () => start());
$("btn-puppet").addEventListener("click", async () => {
  let p: Awaited<ReturnType<typeof createPuppetStream>>;
  try {
    p = await createPuppetStream();
  } catch (err) {
    toast(`<strong>Could not create the demo face:</strong> ${escapeHtml((err as Error).message)}`, true);
    return;
  }
  releaseSources(); // an older demo face or video file
  puppet = p;
  await start(p.stream);
  if (puppet !== p || !tracker.isRunning) return;
  ui.opt.mirror.checked = false; // the demo face is not you: show it unmirrored, like the source
  avatar.setMirror(false);
  ui.pip.classList.remove("mirrored");
  toast("Tracking an animated demo face, not your camera. Everything else works exactly as with a webcam.", false, 5000);
});
ui.videoFile.addEventListener("change", () => {
  const file = ui.videoFile.files?.[0];
  if (!file) return;
  ui.videoFile.value = ""; // picking the same file again fires "change" again
  const v = document.createElement("video");
  v.src = URL.createObjectURL(file);
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  releaseSources();
  fileVideo = v;
  void start(v);
});

// --- scan ---------------------------------------------------------------------------

ui.btn.scan.addEventListener("click", async () => {
  ui.btn.scan.disabled = true;
  ui.scanOverlay.hidden = false;
  try {
    const result = await avatar.scanFace(tracker, (p) => {
      ui.scanMessage.textContent = p.message;
      ui.scanRing.style.strokeDashoffset = String(289 * (1 - p.progress));
    });
    ui.btn.downloadTexture.disabled = ui.btn.clearScan.disabled = false;
    if (result.identity) identitySliders.forEach((s, i) => s.set(avatar.identity[i] ?? 0));
    toast(`Scan done: ${result.views} views used, ${result.skipped} skipped, ${(result.coverage * 100).toFixed(0)}% of the skin captured.`);
  } catch (err) {
    toast(`<strong>Scan stopped:</strong> ${escapeHtml((err as Error).message)}`, true);
  } finally {
    ui.scanOverlay.hidden = true;
    ui.btn.scan.disabled = !tracker.isRunning;
  }
});

ui.btn.downloadTexture.addEventListener("click", async () => download(await avatar.exportTexture(), "likeness-texture.png"));
ui.btn.clearScan.addEventListener("click", () => {
  avatar.clearScan();
  identitySliders.forEach((s) => s.set(0));
  ui.btn.downloadTexture.disabled = ui.btn.clearScan.disabled = true;
});

function download(blob: Blob | null, name: string) {
  if (!blob) return;
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// --- record -------------------------------------------------------------------------

let recorder: MediaRecorder | null = null;
ui.btn.record.addEventListener("click", () => {
  if (recorder) {
    recorder.stop();
    return;
  }
  const canvas = avatar.renderer.domElement;
  const type = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const chunks: Blob[] = [];
  recorder = new MediaRecorder(canvas.captureStream(30), type ? { mimeType: type, videoBitsPerSecond: 8e6 } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    download(new Blob(chunks, { type: recorder!.mimeType }), `likeness-${Date.now()}.${recorder!.mimeType.includes("mp4") ? "mp4" : "webm"}`);
    recorder = null;
    ui.btn.record.textContent = "Record";
    ui.btn.record.classList.remove("recording");
  };
  recorder.start();
  ui.btn.record.textContent = "Stop recording";
  ui.btn.record.classList.add("recording");
});

// --- stage mode ---------------------------------------------------------------------

function setStage(on: boolean) {
  document.body.classList.toggle("stage", on);
  document.body.classList.toggle("transparent", on && ui.opt.background.value === "transparent");
  if (on) toast("Stage mode: press Esc to exit.", false, 2500);
}
ui.btn.stage.addEventListener("click", () => setStage(true));
addEventListener("keydown", (e) => {
  if (e.key === "Escape") setStage(false);
});

// --- panel & options ----------------------------------------------------------------

ui.btn.panel.addEventListener("click", () => document.body.classList.toggle("panel-closed"));
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll<HTMLElement>(".tab").forEach((p) => (p.hidden = p.dataset.tab !== tab.dataset.tab));
  }),
);

ui.opt.mirror.addEventListener("change", () => {
  avatar.setMirror(ui.opt.mirror.checked);
  ui.pip.classList.toggle("mirrored", ui.opt.mirror.checked);
});
ui.pip.classList.toggle("mirrored", ui.opt.mirror.checked);
ui.opt.wireframe.addEventListener("change", () => avatar.setWireframe(ui.opt.wireframe.checked));
ui.opt.background.addEventListener("change", () => {
  avatar.setBackground(ui.opt.background.value);
  document.body.classList.toggle("transparent", document.body.classList.contains("stage") && ui.opt.background.value === "transparent");
});
if (params.get("bg")) ui.opt.background.value = params.get("bg")!;
if (params.has("stage")) setStage(true);
ui.opt.hands.addEventListener("change", async () => {
  try {
    await tracker.setHands(ui.opt.hands.checked);
    ui.chips.hands.hidden = !ui.opt.hands.checked;
  } catch (err) {
    ui.opt.hands.checked = false;
    toast(`<strong>Hand tracking unavailable:</strong> ${escapeHtml((err as Error).message)}`, true);
  }
});
ui.opt.lipsync.addEventListener("change", () => (tracker.options.lipSync = ui.opt.lipsync.checked));
ui.opt.refine.addEventListener("change", () => (tracker.options.refine = ui.opt.refine.checked));
ui.opt.mic.addEventListener("change", async () => {
  try {
    await tracker.setMic(ui.opt.mic.checked);
  } catch (err) {
    ui.opt.mic.checked = false;
    toast(`<strong>Microphone unavailable:</strong> ${escapeHtml((err as Error).message)}`, true);
  }
});
ui.opt.preview.addEventListener("change", () => (ui.pip.hidden = !ui.opt.preview.checked || !lastFrame));
ui.btn.calibrate.addEventListener("click", () => {
  tracker.calibrate();
  toast("Relax your face: calibrating for 1.5 s…", false, 2000);
});

interface Slider { set(v: number): void }
function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): Slider {
  const id = `s-${parent.id}-${label.replace(/\W/g, "")}`;
  const lab = Object.assign(document.createElement("label"), { htmlFor: id, textContent: label, title: label });
  const input = Object.assign(document.createElement("input"), { id, type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = Object.assign(document.createElement("output"), { value: value.toFixed(2) });
  input.addEventListener("input", () => {
    out.value = Number(input.value).toFixed(2);
    onInput(Number(input.value));
  });
  parent.append(lab, input, out);
  return { set(v) { input.value = String(v); out.value = v.toFixed(2); } };
}

const identitySliders: Slider[] = [];
const idEl = $("identity-sliders");
for (let i = 0; i < Math.min(10, avatar.model.nI); i++) {
  identitySliders.push(slider(idEl, `id ${i + 1}`, -3, 3, 0.01, 0, (v) => {
    const c = Float32Array.from(avatar.identity);
    c[i] = v;
    avatar.setIdentity(c);
  }));
}
const gaussian = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
ui.btn.randomIdentity.addEventListener("click", () => {
  const c = Float32Array.from({ length: avatar.model.nI }, gaussian);
  avatar.setIdentity(c);
  identitySliders.forEach((s, i) => s.set(c[i]));
});
ui.btn.resetIdentity.addEventListener("click", () => {
  avatar.setIdentity([]);
  identitySliders.forEach((s) => s.set(0));
});

const tuneEl = $("tuning-sliders");
const o = tracker.options;
slider(tuneEl, "expression gain", 0.5, 3, 0.01, o.gain, (v) => (o.gain = v));
slider(tuneEl, "mouth gain", 0.5, 4, 0.01, o.mouthGain, (v) => (o.mouthGain = v));
slider(tuneEl, "lip motion gain", 0.5, 3, 0.01, o.lipGain, (v) => (o.lipGain = v));
slider(tuneEl, "lip prior", 0, 1, 0.01, o.lipPrior, (v) => (o.lipPrior = v));
slider(tuneEl, "smoothing", 0, 0.9, 0.01, o.smoothing, (v) => (o.smoothing = v));
slider(tuneEl, "mic gain", 0, 3, 0.01, o.micGain, (v) => (o.micGain = v));

// --- streaming ----------------------------------------------------------------------

function onStreamState(s: StreamClient["state"]) {
  ui.chips.stream.hidden = s === "idle";
  setChip(ui.chips.stream, s === "open" ? "on" : s === "connecting" ? "wait" : "off", "stream");
  ui.streamInfo.textContent = {
    idle: "Not connected.",
    connecting: "Connecting… (is `npm run bridge` running?)",
    open: `Streaming to ${ui.streamUrl.value}.`,
    error: "Bridge not reachable; retrying. Start it with `npm run bridge`.",
  }[s];
  ui.btn.stream.textContent = s === "idle" ? "Connect" : "Disconnect";
}
stream.onState = onStreamState;
ui.btn.stream.addEventListener("click", () => {
  if (stream.state === "idle") {
    stream = new StreamClient(ui.streamUrl.value.trim());
    stream.onState = onStreamState;
    stream.connect();
  } else {
    stream.close();
    onStreamState("idle");
  }
});
if (queryBridge) stream.connect();

// --- live readouts (4 Hz) ----------------------------------------------------------

const bars = new Map<string, HTMLElement>();
function renderBars(f: LikenessFrame | null) {
  const bs = f?.face?.blendshapes;
  const top = bs ? ARKIT_BLENDSHAPES.map((n) => [n, bs[n]] as const).sort((a, b) => b[1] - a[1]).slice(0, 10) : [];
  ui.exprBars.replaceChildren(
    ...top.map(([name, v]) => {
      let el = bars.get(name);
      if (!el) {
        el = document.createElement("div");
        el.className = "bar";
        el.innerHTML = `<span>${name}</span><i><b></b></i>`;
        bars.set(name, el);
      }
      (el.querySelector("b") as HTMLElement).style.transform = `scaleX(${v.toFixed(3)})`;
      return el;
    }),
  );
}

setInterval(() => {
  const now = performance.now();
  ui.chips.fps.textContent = `${Math.round((frames * 1000) / (now - fpsT))} fps`;
  frames = 0;
  fpsT = now;
  const f = lastFrame;
  if (tracker.isRunning) {
    if (!f?.face) setChip(ui.chips.face, "off", "no face");
    else setChip(ui.chips.face, f.face.calibrated ? "on" : "wait", f.face.calibrated ? "face" : "calibrating");
    setChip(ui.chips.hands, f?.hands.length ? "on" : "off", f?.hands.length ? `hands ×${f.hands.length}` : "hands");
  }
  if (!document.querySelector('.tab[data-tab="tracking"]')!.hasAttribute("hidden")) renderBars(f);
  if (!document.querySelector('.tab[data-tab="stream"]')!.hasAttribute("hidden") && f) {
    ui.framePreview.textContent = JSON.stringify(f, (_, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v), 1).slice(0, 4000);
  }
  if (!document.querySelector('.tab[data-tab="debug"]')!.hasAttribute("hidden")) {
    ui.perf.textContent = Object.entries(tracker.perf.snapshot())
      .map(([k, v]) => `${k.padEnd(13)} ${v.avg.toFixed(2).padStart(6)}  ${v.p95.toFixed(2).padStart(6)}`)
      .join("\n");
    ui.debugStatus.textContent = JSON.stringify(
      { video: tracker.video ? `${tracker.video.videoWidth}x${tracker.video.videoHeight}` : null, calibrated: tracker.calibrated, hands: f?.hands.map((h) => h.side) ?? [], stream: stream.state },
      null, 1,
    );
  }
}, 250);

// --- landmark overlay on the webcam preview ------------------------------------------

function drawOverlay() {
  requestAnimationFrame(drawOverlay);
  const c = ui.overlay, v = ui.video;
  if (ui.pip.hidden || !v.videoWidth) return;
  if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  if (!ui.opt.overlay.checked) return;
  ctx.fillStyle = "rgba(96, 165, 250, 0.95)";
  for (const p of tracker.lastFaceLandmarks ?? []) ctx.fillRect(p.x * c.width - 1.5, p.y * c.height - 1.5, 3, 3);
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  for (const h of tracker.lastHandLandmarks ?? []) for (let i = 0; i < 21; i++) ctx.fillRect(h[i * 3] * c.width - 2, h[i * 3 + 1] * c.height - 2, 4, 4);
}
drawOverlay();

if (params.has("autostart")) void start();
if (params.has("puppet")) $("btn-puppet").click();

// Dev/test hook (also used for the README screenshots).
Object.assign(window, { likeness: { tracker, avatar, stream, vrm } });
