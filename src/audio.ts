/**
 * Microphone speech meter. Returns a 0..1 "talking" envelope from energy in
 * the speech band (300-3400 Hz), relative to an adaptive noise floor, so it
 * works without tuning in quiet and noisy rooms. Used to open the mouth when
 * the camera under-reports lip motion; it never closes it.
 */
export class SpeechMeter {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private bins: Float32Array<ArrayBuffer>;
  private lo: number;
  private hi: number;
  private floor = -70;
  private env = 0;
  private lastT = 0;

  private constructor(private stream: MediaStream) {
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    src.connect(this.analyser);
    this.bins = new Float32Array(this.analyser.frequencyBinCount);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    this.lo = Math.round(300 / hz);
    this.hi = Math.round(3400 / hz);
  }

  static async start(): Promise<SpeechMeter> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    return new SpeechMeter(stream);
  }

  /** Current envelope, 0 (silent) .. 1 (loud speech). Call once per frame. */
  level(): number {
    this.analyser.getFloatFrequencyData(this.bins);
    let p = 0;
    for (let i = this.lo; i <= this.hi; i++) p += 10 ** (this.bins[i] / 10);
    const db = 10 * Math.log10(p / (this.hi - this.lo + 1) + 1e-12);

    const t = performance.now() / 1000;
    const dt = Math.min(0.1, this.lastT ? t - this.lastT : 0.016);
    this.lastT = t;
    // Noise floor: drops fast to quiet levels, rises slowly (≈ 3 dB/s) so speech doesn't raise it.
    this.floor = db < this.floor ? db : this.floor + 3 * dt;

    const target = Math.max(0, Math.min(1, (db - this.floor - 8) / 25));
    // Fast attack, slower release, like a mouth.
    const k = target > this.env ? 1 - Math.exp(-dt / 0.03) : 1 - Math.exp(-dt / 0.09);
    this.env += k * (target - this.env);
    return this.env;
  }

  stop(): void {
    this.stream.getTracks().forEach((tr) => tr.stop());
    void this.ctx.close();
  }
}
