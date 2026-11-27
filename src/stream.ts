import type { LikenessFrame } from "./frame.js";

/**
 * StreamClient: sends LikenessFrames to a likeness-bridge (bridge/likeness-bridge.mjs) over a
 * WebSocket. It never blocks the page: frames are dropped, not queued, when the socket is not
 * open, when its send buffer is backed up, or when they come faster than `maxHz`. It reconnects
 * on its own with exponential backoff until close() is called. No dependencies.
 */
export type StreamState = "idle" | "connecting" | "open" | "error";

export interface StreamOptions {
  /** Upper bound on frames sent per second; 0 = no cap. Default 60. */
  maxHz?: number;
  /** Drop frames while the socket has more than this many bytes unsent. Default 64 KiB. */
  maxBufferedBytes?: number;
  /** Decimal places kept for every number in the JSON. Default 4 (0.1 mm, 1e-4 weight). */
  precision?: number;
  /** First and largest reconnect delays, ms. Defaults 500 and 10000. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** For tests and non-browser hosts: a WebSocket constructor and a millisecond clock. */
  WebSocketImpl?: { new (url: string): WebSocket };
  now?: () => number;
}

const OPEN = 1;

export class StreamClient {
  state: StreamState = "idle";
  onState?: (s: StreamState) => void;
  /** Counters since construction: frames sent, and frames dropped (closed socket, backpressure, rate cap). */
  readonly stats = { sent: 0, dropped: 0, reconnects: 0 };

  private ws: WebSocket | null = null;
  private wanted = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;
  private nextSendAt = -Infinity;
  private readonly opts: Required<Omit<StreamOptions, "WebSocketImpl" | "now">>;
  private readonly WS: { new (url: string): WebSocket } | undefined;
  private readonly now: () => number;
  private readonly scale: number;

  constructor(readonly url = "ws://localhost:8765", options: StreamOptions = {}) {
    this.opts = {
      maxHz: options.maxHz ?? 60,
      maxBufferedBytes: options.maxBufferedBytes ?? 64 * 1024,
      precision: options.precision ?? 4,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 10000,
    };
    this.WS = options.WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    this.now = options.now ?? (() => performance.now());
    this.backoff = this.opts.minBackoffMs;
    this.scale = 10 ** this.opts.precision;
  }

  /** Starts connecting (and keeps reconnecting until close()). Safe to call repeatedly. */
  connect(): void {
    this.wanted = true;
    if (this.ws || this.retryTimer) return;
    this.open();
  }

  /** Sends one frame if the socket can take it now; otherwise drops it. Returns whether it was sent. */
  send(frame: LikenessFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || ws.bufferedAmount > this.opts.maxBufferedBytes) {
      this.stats.dropped++;
      return false;
    }
    if (this.opts.maxHz > 0) {
      const t = this.now();
      const interval = 1000 / this.opts.maxHz;
      // Average rate <= maxHz, with one interval of slack so jittery 60 fps input isn't halved.
      if (t + 1 < this.nextSendAt) {
        this.stats.dropped++;
        return false;
      }
      this.nextSendAt = Math.max(this.nextSendAt, t - interval) + interval;
    }
    try {
      ws.send(this.encode(frame));
    } catch {
      this.stats.dropped++;
      return false;
    }
    this.stats.sent++;
    return true;
  }

  /** Compact JSON: no whitespace, numbers rounded to `precision` decimals. */
  encode(frame: LikenessFrame): string {
    const s = this.scale;
    return JSON.stringify(frame, (_k, v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * s) / s : v));
  }

  /** Disconnects and stops reconnecting. */
  close(): void {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.setState("idle");
  }

  private open(): void {
    if (!this.WS) {
      this.setState("error");
      return;
    }
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = this.opts.minBackoffMs;
      this.nextSendAt = -Infinity;
      this.setState("open");
    };
    // The bridge may send JSON to us too (e.g. frames from other sources); we ignore it.
    ws.onmessage = null;
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.wanted) this.scheduleRetry();
      else this.setState("idle");
    };
  }

  private scheduleRetry(): void {
    this.setState("error");
    if (!this.wanted || this.retryTimer) return;
    const delay = this.backoff * (0.8 + 0.4 * Math.random());
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.wanted) return;
      this.stats.reconnects++;
      this.open();
    }, delay);
  }

  private setState(s: StreamState): void {
    if (s === this.state) return;
    this.state = s;
    this.onState?.(s);
  }
}
