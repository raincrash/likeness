/**
 * likeness tracking core: webcam -> LikenessFrame (52 ARKit blendshapes, head pose, hands),
 * headless, without the ICT render mesh. Rendering exports live elsewhere (src/lib.ts).
 */
export { LikenessTracker, DEFAULT_CAMERA } from "./tracking.js";
export type { LikenessTrackerOptions, LikenessTrackerEvents, TrackerSource } from "./tracking.js";
export { ARKIT_BLENDSHAPES, HAND_JOINTS, ictToArkit } from "./frame.js";
export type { ArkitName, LikenessFrame, FaceOutput, HandOutput } from "./frame.js";
export { defaultDriveOptions } from "./driver.js";
export type { DriveOptions } from "./driver.js";
export { LandmarkModel } from "./landmarkModel.js";
export { headPose, matToQuat, DEFAULT_HFOV_DEG } from "./frameBuilder.js";
