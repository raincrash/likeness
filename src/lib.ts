/**
 * likeness: webcam face, lip-sync and hand tracking for driving avatars.
 *
 *   import { LikenessTracker, LikenessAvatar, StreamClient } from "likeness";
 *
 * Sub-entries: "likeness/tracking" (tracking only, no three.js), "likeness/element" (<likeness-avatar>),
 * "likeness/vrm" (VrmAvatar).
 */
import "./lib-assets.js";

export * from "./index.js";
export { LikenessAvatar } from "./avatar.js";
/** The ICT-FaceKit face model (load, set identity, evaluate expressions): for custom renderers. */
export { IctModel } from "./ict.js";
export type { IctMeta } from "./ict.js";
export type { AvatarOptions, ScanSource, ScanProgress, ScanResult, ScanOptions } from "./avatar.js";
export { StreamClient } from "./stream.js";
export type { StreamOptions, StreamState } from "./stream.js";
export { setAssetBase, assetBase, assetUrl } from "./assets.js";
