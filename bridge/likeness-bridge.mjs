#!/usr/bin/env node
// likeness-bridge: receives LikenessFrames from the browser over WebSocket, re-broadcasts them as
// JSON to every other WebSocket client, and sends them to VMC protocol receivers (VSeeFace, VNyan,
// Warudo, VMagicMirror, EVMC4U, VMC4B, ...) as OSC over UDP. See bridge/README.md.

import dgram from "node:dgram";
import { realpathSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { encodeMessage, packBundles } from "./osc.mjs";
import { DEFAULT_OPTIONS, frameToVmc, validateFrame } from "./vmc.mjs";

const VERSION = "0.1.0";
const MAX_PAYLOAD = 256 * 1024;
/** At most this many simultaneous WebSocket clients (browser sources + consumers). */
const MAX_CLIENTS = 16;
/** Per-client message cap; frames arrive at <= 60/s. */
const MAX_MESSAGES_PER_SECOND = 240;
/** Stop sending to a consumer whose socket has this much unsent data (it is too slow). */
const CONSUMER_BUFFER_LIMIT = 1 << 20;
/** A newer source may take over at any time; an older one only after the active one is quiet this long. */
const SOURCE_TIMEOUT_MS = 1000;

const HELP = `likeness-bridge ${VERSION}: stream likeness face/hand tracking to your own avatar

Usage: node bridge/likeness-bridge.mjs [options]     (or: npm run bridge -- [options])

  --port <n>              WebSocket port (default 8765)
  --host <addr>           WebSocket bind address (default: loopback only, 127.0.0.1 and ::1).
                          Use 0.0.0.0 to accept other machines; anyone on the network can then
                          read your tracking data.
  --allow-origin <url>    Also accept browser pages from this origin (repeatable). Pages on
                          localhost / 127.0.0.1 and non-browser clients are always accepted.
  --allow-any-origin      Accept any web page (not recommended: any site you visit could connect).
  --vmc <host:port>       VMC (OSC/UDP) destination (default 127.0.0.1:39539)
  --no-vmc                Don't send VMC
  --mirror                Mirror the performer: the avatar acts like your reflection
                          (left/right swapped). Default: anatomical, your left = avatar's left.
  --blend-case <c>        ARKit names over VMC: pascal (JawOpen, default), camel (jawOpen) or both
  --blendshapes <set>     all (default), arkit (perfect sync only) or vrm (VRM presets only)
  --no-emotions           Send Joy/Angry/Sorrow/Fun as 0
  --no-hands              Don't send hand and finger bones
  --neck <0..1>           Share of head rotation put on the Neck bone (default 0.3)
  --root-motion           Move the VMC Root with your head position
  --no-bundles            Send each OSC message as its own UDP packet
  --log                   Print every frame as one JSON line on stdout (status goes to stderr)
  --quiet                 Only print the banner and errors
  -h, --help              Show this help
`;

export function parseArgs(argv) {
  const o = {
    port: 8765, host: null, origins: [], anyOrigin: false, vmc: { host: "127.0.0.1", port: 39539 },
    bundles: true, log: false, quiet: false, help: false, vmcOptions: { ...DEFAULT_OPTIONS },
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith("--") && a.includes("=")) [a, inline] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
    const val = () => {
      if (inline != null) return inline;
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case "--port": o.port = toPort(val(), a); break;
      case "--host": o.host = val(); break;
      case "--allow-origin": o.origins.push(val().replace(/\/$/, "")); break;
      case "--allow-any-origin": o.anyOrigin = true; break;
      case "--vmc": o.vmc = parseHostPort(val()); break;
      case "--no-vmc": o.vmc = null; break;
      case "--mirror": o.vmcOptions.mirror = true; break;
      case "--blend-case": {
        const v = val();
        if (!["pascal", "camel", "both"].includes(v)) throw new Error("--blend-case must be pascal, camel or both");
        o.vmcOptions.blendCase = v;
        break;
      }
      case "--blendshapes": {
        const v = val();
        if (!["all", "arkit", "vrm"].includes(v)) throw new Error("--blendshapes must be all, arkit or vrm");
        o.vmcOptions.blendshapes = v;
        break;
      }
      case "--no-emotions": o.vmcOptions.emotions = false; break;
      case "--no-hands": o.vmcOptions.hands = false; break;
      case "--neck": {
        const v = Number(val());
        if (!(v >= 0 && v <= 1)) throw new Error("--neck must be between 0 and 1");
        o.vmcOptions.neckShare = v;
        break;
      }
      case "--root-motion": o.vmcOptions.rootMotion = true; break;
      case "--no-bundles": o.bundles = false; break;
      case "--log": o.log = true; break;
      case "--quiet": o.quiet = true; break;
      case "-h": case "--help": o.help = true; break;
      default: throw new Error(`unknown option ${a} (see --help)`);
    }
  }
  return o;
}

function toPort(s, flag) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${flag}: bad port ${s}`);
  return n;
}

/** "host:port", "[::1]:port" or just "port". */
export function parseHostPort(s) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) || /^([^:]+):(\d+)$/.exec(s);
  if (m) return { host: m[1], port: toPort(m[2], "--vmc") };
  if (/^\d+$/.test(s)) return { host: "127.0.0.1", port: toPort(s, "--vmc") };
  throw new Error(`--vmc: expected host:port, got ${s}`);
}

function isLocalOrigin(origin) {
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Starts the bridge. Resolves to { port, close() } once listening. Options as parseArgs returns,
 * plus `out`/`err` writers (default process.stdout/stderr) for tests.
 */
export async function startBridge(options = {}) {
  const o = { ...parseArgs([]), ...options };
  o.vmcOptions = { ...DEFAULT_OPTIONS, ...(options.vmcOptions || {}) };
  const out = o.out || ((s) => process.stdout.write(s));
  const err = o.err || ((s) => process.stderr.write(s));
  const info = (s) => { if (!o.quiet) err(s + "\n"); };

  const startedAt = process.hrtime.bigint();
  const clients = new Map(); // ws -> { id, connectedAt, lastFrameAt, origin }
  let nextId = 1;
  let active = null;
  const stats = { frames: 0, bad: 0, ignored: 0, lastBadLog: 0, lastBad: "" };
  const vmcState = {};

  // --- VMC sender
  let udp = null;
  if (o.vmc) {
    udp = dgram.createSocket(o.vmc.host.includes(":") ? "udp6" : "udp4");
    udp.on("error", (e) => err(`VMC socket error: ${e.message}\n`));
    udp.unref();
  }
  const sendVmc = (frame) => {
    const t = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const encoded = frameToVmc(frame, o.vmcOptions, vmcState, t).map((m) => encodeMessage(m.address, m.args));
    const packets = o.bundles ? packBundles(encoded, 1500) : encoded;
    for (const p of packets) udp.send(p, o.vmc.port, o.vmc.host);
  };

  // --- WebSocket server (loopback on both stacks by default)
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  const servers = [];
  const onUpgrade = (req, socket, head) => {
    const origin = req.headers.origin;
    const ok = !origin || o.anyOrigin || isLocalOrigin(origin) || o.origins.includes(origin);
    if (!ok) {
      info(`rejected a page from origin ${origin} (allow it with --allow-origin ${origin})`);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (clients.size >= MAX_CLIENTS) {
      info(`rejected a connection: ${MAX_CLIENTS} clients already connected`);
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  const listen = (host, port) =>
    new Promise((resolve, reject) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(426, { "content-type": "text/plain" });
        res.end("likeness-bridge: connect with a WebSocket\n");
      });
      srv.on("upgrade", onUpgrade);
      srv.once("error", reject);
      srv.listen(port, host, () => {
        srv.off("error", reject);
        servers.push(srv);
        resolve(srv.address().port);
      });
    });

  const port = await listen(o.host || "127.0.0.1", o.port);
  if (!o.host) await listen("::1", port).catch(() => {}); // no IPv6 loopback: fine

  wss.on("connection", (ws, req) => {
    const c = { id: nextId++, connectedAt: Date.now(), lastFrameAt: 0, origin: req.headers.origin || "", windowStart: 0, inWindow: 0 };
    clients.set(ws, c);
    info(`client #${c.id} connected${c.origin ? ` from ${c.origin}` : ""} (${clients.size} connected)`);
    ws.on("message", (data, isBinary) => {
      // Rate limit per client: tracking runs at <= 60 fps; anything far above is a bug or abuse.
      const t = Date.now();
      if (t - c.windowStart >= 1000) {
        c.windowStart = t;
        c.inWindow = 0;
      }
      if (++c.inWindow > MAX_MESSAGES_PER_SECOND) {
        if (c.inWindow === MAX_MESSAGES_PER_SECOND + 1) info(`client #${c.id} exceeds ${MAX_MESSAGES_PER_SECOND} messages/s; dropping the excess`);
        return;
      }
      if (isBinary) return bad(ws, "binary messages are not frames");
      let frame;
      try {
        frame = validateFrame(JSON.parse(data.toString("utf8")));
      } catch (e) {
        return bad(ws, e.message);
      }
      const now = Date.now();
      const cur = active && clients.get(active);
      if (cur && active !== ws && c.connectedAt < cur.connectedAt && now - cur.lastFrameAt < SOURCE_TIMEOUT_MS) {
        stats.ignored++;
        return; // an older source while a newer one is live
      }
      if (active !== ws) info(`client #${c.id} is now the tracking source`);
      active = ws;
      c.lastFrameAt = now;
      stats.frames++;
      const json = JSON.stringify(frame);
      for (const [other] of clients) {
        if (other !== ws && other.readyState === 1 && other.bufferedAmount < CONSUMER_BUFFER_LIMIT) other.send(json);
      }
      if (o.log) out(json + "\n");
      if (udp) {
        try {
          sendVmc(frame);
        } catch (e) {
          err(`VMC encode failed: ${e.message}\n`);
        }
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
      if (active === ws) active = null;
      info(`client #${c.id} disconnected (${clients.size} connected)`);
    });
    ws.on("error", () => {});
  });

  function bad(ws, why) {
    stats.bad++;
    const now = Date.now();
    if (now - stats.lastBadLog > 5000 || why !== stats.lastBad) {
      err(`ignored a malformed frame from client #${clients.get(ws)?.id}: ${why}\n`);
      stats.lastBadLog = now;
      stats.lastBad = why;
    }
  }

  const statusTimer = setInterval(() => {
    if (stats.frames || stats.bad) {
      info(`${(stats.frames / 10).toFixed(1)} frames/s, ${clients.size} client(s)` +
        (stats.bad ? `, ${stats.bad} malformed` : "") + (stats.ignored ? `, ${stats.ignored} from inactive sources` : ""));
    }
    stats.frames = stats.bad = stats.ignored = 0;
  }, 10000);
  statusTimer.unref();

  return {
    port,
    async close() {
      clearInterval(statusTimer);
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
      if (udp) udp.close();
    },
  };
}

function banner(o, port) {
  const host = o.host || "127.0.0.1";
  const v = o.vmcOptions;
  const lines = [
    `likeness-bridge ${VERSION}`,
    o.host
      ? `  WebSocket  ws://${host.includes(":") ? `[${host}]` : host}:${port}`
      : `  WebSocket  ws://localhost:${port}  (loopback only: 127.0.0.1 and ::1)`,
    `             browser sends frames here; every other client receives them as JSON`,
    o.vmc
      ? `  VMC        osc/udp ${o.vmc.host}:${o.vmc.port}  mirror ${v.mirror ? "on" : "off"}, blendshapes ${v.blendshapes}` +
        `${v.blendshapes !== "vrm" ? ` (ARKit names ${v.blendCase})` : ""}, hands ${v.hands ? "on" : "off"}`
      : `  VMC        off`,
    `  Log        ${o.log ? "JSON lines on stdout" : "off (--log)"}`,
    `  Ctrl+C to stop. --help for options.`,
    ``,
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`likeness-bridge: ${e.message}\n`);
    process.exit(2);
  }
  if (o.help) {
    process.stdout.write(HELP);
    return;
  }
  let bridge;
  try {
    bridge = await startBridge(o);
  } catch (e) {
    const hint = e.code === "EADDRINUSE" ? ` (is another bridge running? try --port ${o.port + 1})` : "";
    process.stderr.write(`likeness-bridge: could not listen on port ${o.port}: ${e.message}${hint}\n`);
    process.exit(1);
  }
  banner(o, bridge.port);
  const stop = () => bridge.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Run when executed directly (node bridge/likeness-bridge.mjs, or through the npm bin symlink).
const self = fileURLToPath(import.meta.url);
let invoked = "";
try {
  invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
} catch {}
if (invoked === self) main();
