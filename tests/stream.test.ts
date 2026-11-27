// StreamClient with a fake WebSocket: rate cap, backpressure drops, compact JSON, reconnect with backoff.
import { StreamClient, type StreamState } from "../src/stream.js";
import type { LikenessFrame } from "../src/frame.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
  // test helpers
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const frame = (t: number): LikenessFrame => ({ v: 1, t, face: null, hands: [{ side: "left", score: 0.98765432, joints: Array.from({ length: 21 }, () => [0.123456789, -1e-7, 2] as [number, number, number]) }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Top-level await needs module es2022; tsconfig.test.json emits ES2020.
void (async () => {
  let clock = 0;
  const states: StreamState[] = [];
  const c = new StreamClient("ws://localhost:9999", {
    WebSocketImpl: FakeSocket as unknown as { new (url: string): WebSocket },
    now: () => clock,
    maxHz: 60,
    minBackoffMs: 10,
    maxBackoffMs: 40,
  });
  c.onState = (s) => states.push(s);

  check("starts idle", c.state === "idle");
  check("send before connect drops", c.send(frame(0)) === false && c.stats.dropped === 1);
  c.connect();
  const ws1 = FakeSocket.all[0];
  check("connecting", c.state === "connecting" && ws1.url === "ws://localhost:9999");
  ws1.accept();
  check("open", c.state === "open");

  // Rate cap: 120 frames at 120 Hz over one second -> about 60 sent.
  let sent = 0;
  for (let i = 0; i < 120; i++) {
    clock = i * (1000 / 120);
    if (c.send(frame(clock))) sent++;
  }
  check("60 Hz cap at 120 fps input", sent >= 59 && sent <= 62, `${sent} sent`);
  // Jittery 60 fps input (frames 14-19 ms apart) is not thinned.
  sent = 0;
  clock = 10000;
  for (let i = 0; i < 60; i++) {
    clock += i % 2 ? 14 : 19;
    if (c.send(frame(clock))) sent++;
  }
  check("jittery 60 fps input passes", sent >= 58, `${sent}/60 sent`);

  // Backpressure.
  clock += 100;
  ws1.bufferedAmount = 1 << 20;
  check("drops while bufferedAmount is high", c.send(frame(clock)) === false);
  ws1.bufferedAmount = 0;
  check("sends again once drained", c.send(frame(clock)) === true);

  // Compact JSON.
  const json = ws1.sent[ws1.sent.length - 1];
  const parsed = JSON.parse(json);
  check("compact JSON (no spaces, rounded)", !json.includes(" ") && parsed.hands[0].score === 0.9877 && parsed.hands[0].joints[0][0] === 0.1235 && parsed.hands[0].joints[0][1] === 0,
    json.slice(0, 80));

  // Reconnect with backoff.
  ws1.drop();
  check("error after a drop", c.state === "error");
  await sleep(30);
  const ws2 = FakeSocket.all[1];
  check("reconnects after backoff", !!ws2 && c.state === "connecting" && c.stats.reconnects === 1);
  ws2.drop(); // refused again
  await sleep(60);
  check("keeps retrying", FakeSocket.all.length === 3);
  FakeSocket.all[2].accept();
  check("open again", c.state === "open");

  c.close();
  check("close -> idle", c.state === "idle");
  await sleep(60);
  check("no reconnect after close", FakeSocket.all.length === 3);
  check("state sequence", states.join(",") === "connecting,open,error,connecting,error,connecting,open,idle", states.join(","));

  if (failures) {
    console.log(`${failures} stream test(s) failed`);
    process.exit(1);
  }
})();
