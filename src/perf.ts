/** Rolling per-stage timings (ms): exponential moving average plus p95 over the last 240 samples. */
export class Perf {
  private ema = new Map<string, number>();
  private hist = new Map<string, number[]>();

  add(stage: string, ms: number): void {
    const prev = this.ema.get(stage);
    this.ema.set(stage, prev === undefined ? ms : prev * 0.9 + ms * 0.1);
    const h = this.hist.get(stage) ?? [];
    h.push(ms);
    if (h.length > 240) h.shift();
    this.hist.set(stage, h);
  }

  /** Times fn and records it under `stage`. */
  time<T>(stage: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.add(stage, performance.now() - t0);
    }
  }

  snapshot(): Record<string, { avg: number; p95: number; n: number }> {
    const out: Record<string, { avg: number; p95: number; n: number }> = {};
    for (const [k, v] of this.ema) {
      const h = [...(this.hist.get(k) ?? [])].sort((a, b) => a - b);
      out[k] = { avg: v, p95: h[Math.min(h.length - 1, Math.floor(h.length * 0.95))] ?? v, n: h.length };
    }
    return out;
  }

  reset(): void {
    this.ema.clear();
    this.hist.clear();
  }
}
