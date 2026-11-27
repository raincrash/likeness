/**
 * likeness/tracking: the tracking core only (no three.js). Webcam -> LikenessFrame
 * (52 ARKit blendshapes, head pose, hands), plus the bridge client for streaming.
 */
import "./lib-assets.js";

export * from "./index.js";
export { StreamClient } from "./stream.js";
export type { StreamOptions, StreamState } from "./stream.js";
export { setAssetBase, assetBase, assetUrl } from "./assets.js";
