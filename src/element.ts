import { LikenessAvatar } from "./avatar.js";
import { LikenessTracker } from "./tracking.js";
import { StreamClient } from "./stream.js";
import type { LikenessFrame } from "./frame.js";

/**
 * <likeness-avatar>: webcam -> tracking -> 3D avatar in one tag.
 *
 *   <likeness-avatar autostart hands mirror background="transparent"
 *                    stream="ws://localhost:8765"></likeness-avatar>
 *
 * Attributes:
 *   autostart            start the webcam on load (browsers may require a click first; call start())
 *   hands                also track hands
 *   no-lip-sync          disable the landmark lip-sync fit
 *   no-mirror            show the avatar unmirrored
 *   background           "studio" (default) | "transparent" | any CSS colour
 *   stream               WebSocket URL of a likeness bridge to send frames to
 *   model-url            folder with ict.json/ict.bin and ict-landmarks.json
 *   hands-url            folder with left.glb/right.glb
 *
 * Properties: .tracker, .avatar (available after the "ready" event), start(), stop(), scan(), dispose().
 * A removed element releases its WebGL context and MediaPipe after 1 s (re-attaching re-creates them).
 * Events: "ready", "frame" (detail: LikenessFrame), "error" (detail: Error).
 */
export class LikenessAvatarElement extends HTMLElement {
  static readonly observedAttributes = ["background", "no-mirror", "hands"];
  tracker: LikenessTracker | null = null;
  avatar: LikenessAvatar | null = null;
  private stream: StreamClient | null = null;
  private ready: Promise<void> | null = null;
  private root: HTMLDivElement;
  private disposeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>:host{display:block;position:relative;min-height:240px;contain:strict}div{position:absolute;inset:0}</style><div></div>`;
    this.root = shadow.querySelector("div")!;
  }

  connectedCallback(): void {
    clearTimeout(this.disposeTimer);
    if (!this.ready) {
      this.ready = this.init().catch((err: Error) => {
        this.fail(err);
        throw err;
      });
      this.ready.catch(() => {}); // reported via the "error" event; start()/scan() still reject
    }
    this.stream?.connect(); // re-attached after a disconnect
    if (this.hasAttribute("autostart")) void this.ready.then(() => this.start()).catch((err) => this.fail(err));
  }

  disconnectedCallback(): void {
    this.stop();
    // Otherwise a removed element keeps reconnecting to the bridge forever.
    this.stream?.close();
    // Moving the element in the DOM disconnects and reconnects it in one task: only release the
    // WebGL context and MediaPipe if it stays detached.
    this.disposeTimer = setTimeout(() => this.dispose(), 1000);
  }

  attributeChangedCallback(name: string): void {
    if (!this.avatar) return;
    if (name === "background") this.avatar.setBackground(this.getAttribute("background") ?? "studio");
    if (name === "no-mirror") this.avatar.setMirror(!this.hasAttribute("no-mirror"));
    if (name === "hands") this.tracker?.setHands(this.hasAttribute("hands")).catch((err: Error) => this.fail(err));
  }

  /** Releases the renderer, MediaPipe and the bridge connection. The element can be re-attached afterwards. */
  dispose(): void {
    clearTimeout(this.disposeTimer);
    this.stream?.close();
    this.tracker?.dispose();
    this.avatar?.dispose();
    this.tracker = this.avatar = this.stream = null;
    this.ready = null;
  }

  private fail(err: Error): void {
    this.dispatchEvent(new CustomEvent("error", { detail: err }));
  }

  private async init(): Promise<void> {
    const modelUrl = this.getAttribute("model-url") ?? undefined;
    const [tracker, avatar] = await Promise.all([
      LikenessTracker.create({ hands: this.hasAttribute("hands"), lipSync: !this.hasAttribute("no-lip-sync"), modelUrl }),
      LikenessAvatar.create({
        container: this.root,
        modelUrl,
        handsUrl: this.getAttribute("hands-url") ?? undefined,
        mirror: !this.hasAttribute("no-mirror"),
        background: this.getAttribute("background") ?? "studio",
      }),
    ]);
    this.tracker = tracker;
    this.avatar = avatar;
    const url = this.getAttribute("stream");
    if (url) {
      this.stream = new StreamClient(url);
      this.stream.connect();
    }
    tracker.on("error", (err: Error) => this.fail(err));
    tracker.on("frame", (f: LikenessFrame) => {
      avatar.apply(f);
      this.stream?.send(f);
      this.dispatchEvent(new CustomEvent("frame", { detail: f }));
    });
    this.dispatchEvent(new CustomEvent("ready"));
  }

  /** Starts the webcam (or the given source) and tracking. */
  async start(source?: Parameters<LikenessTracker["start"]>[0]): Promise<void> {
    await this.ready;
    await this.tracker!.start(source);
  }

  stop(): void {
    this.tracker?.stop();
  }

  /** Runs the ~10 s face scan (shape + texture) on the running webcam. */
  async scan(onProgress?: Parameters<LikenessAvatar["scanFace"]>[1]) {
    await this.ready;
    return this.avatar!.scanFace(this.tracker!, onProgress);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("likeness-avatar")) {
  customElements.define("likeness-avatar", LikenessAvatarElement);
}
