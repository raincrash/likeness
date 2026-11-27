# API reference

Everything listed here is exported by one of the three entry points:

| Entry point | Exports |
|---|---|
| `likeness` | `LikenessTracker`, `DEFAULT_CAMERA`, `LikenessAvatar`, `StreamClient`, `setAssetBase`, `assetBase`, `assetUrl`, `ARKIT_BLENDSHAPES`, `HAND_JOINTS`, `ictToArkit`, `defaultDriveOptions`, `LandmarkModel`, `headPose`, `matToQuat`, `DEFAULT_HFOV_DEG` |
| `likeness/tracking` | The tracking subset of `likeness` without three.js: `LikenessTracker`, `DEFAULT_CAMERA`, `StreamClient`, `setAssetBase`, `assetBase`, `assetUrl`, `ARKIT_BLENDSHAPES`, `HAND_JOINTS`, `ictToArkit`, `defaultDriveOptions`, `LandmarkModel`, `headPose`, `matToQuat`, `DEFAULT_HFOV_DEG` |
| `likeness/element` | `LikenessAvatarElement` (and registers `<likeness-avatar>`) |
| `likeness/vrm` | `VrmAvatar` |

Exported types: `LikenessFrame`, `FaceOutput`, `HandOutput`, `ArkitName`, `LikenessTrackerOptions`,
`LikenessTrackerEvents`, `TrackerSource`, `DriveOptions`, `AvatarOptions`, `ScanSource`, `ScanOptions`, `ScanProgress`,
`StreamOptions`, `StreamState`,
`ScanResult` (from `likeness`) and `VrmMeta`, `VrmApplyOptions` (from `likeness/vrm`).

For installation and asset hosting see the [README](../README.md#installation) and [Hosting](hosting.md); for how the
pieces fit together see [architecture.md](architecture.md).

## LikenessTracker

Headless webcam tracking: video in, `LikenessFrame`s out. No rendering; it loads MediaPipe and the
0.4 MB landmark model only.

```ts
const tracker = await LikenessTracker.create({ hands: true });
tracker.on("frame", (f) => { /* ... */ });
await tracker.start();
```

### `LikenessTracker.create(options?)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `hands` | boolean | `false` | Also track hands (loads MediaPipe's hand landmarker). Can be changed later with `setHands()`. |
| `lipSync` | boolean | `true` | Landmark lip-sync fit (sets `options.lipSync`). |
| `modelUrl` | string | `assetUrl("ict")` | Folder with `ict-landmarks.json` and `ict-landmarks.bin`. |
| `wasmUrl` | string | jsDelivr, `@mediapipe/tasks-vision@1.2.3/wasm` | Folder with MediaPipe's wasm files. |
| `faceModelUrl` | string | Google model storage, `face_landmarker.task` (float16) | MediaPipe face model. |
| `handModelUrl` | string | Google model storage, `hand_landmarker.task` (float16) | MediaPipe hand model. |
| `hfov` | number | `65` | Assumed horizontal field of view in degrees; used for head and hand positions only. |
| `options` | `Partial<DriveOptions>` | | Initial driver options, merged over `defaultDriveOptions`. |
| `worker` | boolean | `true` | Run MediaPipe in Web Workers: face and hands in parallel, off the main thread. Falls back to the main thread (with a console warning) when the browser can't. `process()` needs `false`. |
| `workerUrl` | string \| URL | `assetUrl("detect-worker.js")` | The worker script. Library builds ship it in the assets folder; from source, your bundler builds it. |

### Methods

| Method | Description |
|---|---|
| `start(source?)` | Starts tracking and resolves once frames flow. `source`: a `<video>` (used as is, played if paused), a `MediaStream`, or `{ camera?: MediaTrackConstraints }` (default `DEFAULT_CAMERA`: 1280x720, user-facing). Restarts calibration. |
| `stop()` | Stops the loop and releases a camera the tracker opened. Listeners stay. |
| `dispose()` | `stop()`, then releases MediaPipe, the microphone and all listeners. Not reusable afterwards. |
| `process(video, timestampMs)` | Processes one frame by hand (custom loops, offline video), synchronously on the main thread: create the tracker with `worker: false`. Timestamps must increase. Returns the frame, or `null` if the video has no data yet. Don't mix with `start()`. |
| `calibrate()` | Restarts the neutral-face calibration (45 face frames, about 1.5 s). |
| `fitIdentity()` | Fits identity coefficients to the calibrated neutral face, applies them to the tracker's landmark model and returns them (`Float32Array`), or `null` before calibration. |
| `setIdentity(coeffs)` | Applies saved identity coefficients to the landmark model. |
| `setHands(on)` | Turns hand tracking on or off; loads the hand model the first time. Async. |
| `setMic(on)` | Turns the microphone speech assist on or off (asks for microphone access). Async. |
| `on(type, fn)` / `off(type, fn)` | Adds or removes an event listener. Chainable. |

### Events

| Event | Arguments | When |
|---|---|---|
| `frame` | `LikenessFrame` | Every processed video frame (`face` is `null` without a face). |
| `calibrated` | | Neutral calibration finished. |
| `error` | `Error` | A failure in `start()` or the tracking loop; the loop keeps running. |
| `start` | `HTMLVideoElement` | Tracking started on this video. |
| `stop` | | Tracking stopped. |

### Properties

| Property | Description |
|---|---|
| `options` | Live `DriveOptions`; changes apply from the next frame. |
| `perf` | Rolling per-stage timings: `perf.snapshot()` returns `{ [stage]: { avg, p95, n } }` in ms for `faceDetect`, `handDetect` (MediaPipe, measured in the worker in worker mode), `detectWait` (worker mode: frame capture to results), `drive`, `frame`, `trackTotal` (video frame to emitted `LikenessFrame`). |
| `backend` | `"worker"` or `"main"`: where MediaPipe runs. |
| `video` | The tracked `<video>` (an idle, detached element owned by the tracker before `start()`). |
| `lastFrame` | The last `LikenessFrame`, or `null`. |
| `calibrated`, `calibration` | Calibration done (boolean) and progress (0..1). |
| `isRunning`, `hands`, `mic` | Loop running, hand tracking on, mic assist on. |
| `focalPx` | Focal length in video pixels implied by `hfov`. |
| `landmarks` | The `LandmarkModel` (identity-adjusted by `fitIdentity()` / `setIdentity()`). |
| `lastFaceLandmarks` | Debug/overlay data: the last frame's face landmarks in normalised image coordinates (x right, y down, unmirrored), or `null`. |
| `lastHandLandmarks` | Debug/overlay data: per hand, 21x3 normalised image landmarks. |
| `lastProjection` | Camera-pixel to head-model similarity of the last frame (used by the face scan). |
| `ictWeights`, `ictNames` | Filtered ICT expression weights and their names, for the bundled ICT renderer. |

### `DriveOptions`

Read and write them live through `tracker.options`. Defaults are `defaultDriveOptions`.

| Option | Default | Meaning |
|---|---|---|
| `lipSync` | `true` | Fit mouth and jaw shapes to lip landmark motion relative to the calibrated neutral. |
| `gain` | `1.2` | Multiplier on MediaPipe scores after removing the neutral baseline. |
| `mouthGain` | `2` | Extra multiplier for mouth and jaw scores. |
| `lipGain` | `1.8` | Multiplier on measured lip motion before fitting (exaggeration). |
| `lipPrior` | `0.15` | How strongly the lip fit sticks to MediaPipe's scores (0 = landmarks only). |
| `smoothing` | `0.35` | 0 = raw, 0.9 = very smooth (scales the One Euro cutoffs). |
| `micGain` | `1` | Strength of the microphone speech assist. |
| `refine` | `false` | Full-face landmark refinement of all expression weights (slower). |
| `regularization`, `temporal`, `min`, `max`, `iterations` | `0.01`, `0.3`, `0`, `1`, `2` | Settings of the full-face refine fit. |

## LikenessAvatar

The built-in renderer: the ICT-FaceKit head plus rigged hands, driven by `LikenessFrame`s from a local
tracker or from anywhere else (e.g. a WebSocket).

### `LikenessAvatar.create(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `container` | HTMLElement | required | A canvas is created inside it and follows its size. |
| `modelUrl` | string | `assetUrl("ict")` | Folder with `ict.json` and `ict.bin`. |
| `handsUrl` | string | `assetUrl("hands")` | Folder with `left.glb` and `right.glb`. |
| `mirror` | boolean | `true` | Show the avatar as a mirror image, like a webcam preview. |
| `background` | string | `"studio"` | `"studio"`, `"transparent"` (OBS, overlays) or any CSS colour. |
| `orbit` | boolean | `true` | Mouse orbit controls. |
| `hands` | boolean | `true` | Render hands when frames contain them (models load on first use). |
| `maxPixelRatio` | number | `2` | Device pixel ratio cap. |
| `framing` | `"auto"` \| `"head"` \| `"upper-body"` | `"auto"` | Camera framing. `auto` shows a head close-up and widens to the upper body while hands are visible. Orbiting with the mouse turns it off until `setFraming()` is called. |

The canvas only has an alpha channel when the avatar is created with `background: "transparent"`, so
create it that way if you need transparency at any point.

### Methods

| Method | Description |
|---|---|
| `apply(frame)` | Applies one `LikenessFrame`: expressions, head rotation, hands. |
| `setFraming(framing)` | `"auto"`, `"head"` or `"upper-body"`; also re-enables automatic framing after the user orbited. |
| `setWireframe(on)` | Wireframe for the head, the hands and any custom avatar (e.g. a VRM). |
| `scanFace(source, onProgress?, options?)` | Face scan, about 10 s: calibrates, fits identity, bakes the skin texture while the user turns their head. `source` is a `LikenessTracker` (anything implementing `ScanSource`). Resolves to `ScanResult`. Rejects with an `AbortError` if the source stops, calibration does not finish within `options.calibrationTimeout` seconds (default 15), `options.signal` aborts, or the avatar is disposed. Only one scan runs at a time. |
| `clearScan()` | Removes the scanned texture and identity. |
| `exportTexture()` | PNG `Blob` of the scanned texture, or `null` before a scan. |
| `snapshot()` | PNG `Blob` of the current view. |
| `setMirror(on)`, `mirrored` | Mirror on or off; current state. |
| `setBackground(bg)` | Same values as the `background` option. |
| `setIdentity(coeffs)` | Head shape from identity coefficients (N(0,1) PCA weights, up to `model.nI`). |
| `setExpressionWeights(weights)` | ICT expression weights directly, in `model.expressionNames` order. |
| `setHeadRotation(q)` | Head rotation directly (`THREE.Quaternion`, camera frame). |
| `setCustomAvatar(object)` | Shows another `THREE.Object3D` (e.g. `VrmAvatar.scene`) instead of the built-in head and hands; `null` restores it. Added unmirrored. |
| `onRender(cb)` | Calls `cb(dt)` before each rendered frame; returns an unsubscribe function. |
| `dispose()` | Stops rendering and frees GPU resources. |

Properties: `renderer`, `scene`, `camera`, `controls`, `model` (the ICT model), `weights`, `identity`,
`look` (lighting and materials).

`ScanProgress`: `{ phase: "calibrating" | "capturing" | "done", progress: 0..1, message, coverage? }`.
`ScanResult`: `{ views, skipped, coverage, identity }`.

## `<likeness-avatar>` (`LikenessAvatarElement`)

`import "likeness/element"` (or load `dist/standalone/element.js`) registers the element. It creates a
`LikenessTracker` and a `LikenessAvatar` and wires them together.

| Attribute | Meaning | Re-read on change |
|---|---|---|
| `autostart` | Start the webcam once loaded (browsers may require a user gesture first). | no |
| `hands` | Track hands. | yes |
| `no-lip-sync` | Disable the lip-sync fit. | no |
| `no-mirror` | Show the avatar unmirrored. | yes |
| `background` | `studio` (default), `transparent` or any CSS colour. | yes |
| `stream` | WebSocket URL of a likeness bridge; frames are sent with a `StreamClient`. | no |
| `model-url` | Folder with `ict.json`, `ict.bin`, `ict-landmarks.json` and `ict-landmarks.bin`. | no |
| `hands-url` | Folder with `left.glb` and `right.glb`. | no |

| Member | Description |
|---|---|
| `tracker`, `avatar` | The underlying objects, set before the `ready` event. |
| `start(source?)` | Same as `LikenessTracker.start()`. |
| `stop()` | Stops tracking (also called when the element is removed from the page). |
| `scan(onProgress?)` | Runs the face scan; resolves to `ScanResult`. |
| `dispose()` | Releases the renderer, MediaPipe and the bridge connection. Also happens automatically 1 s after the element is removed from the page. |

Events: `ready`, `frame` (`event.detail` is the `LikenessFrame`), `error` (`event.detail` is the `Error`).
The element is `display: block` with a minimum height of 240 px; size it with CSS.

## StreamClient

Sends frames to `likeness-bridge` over a WebSocket. It never queues: a frame is dropped when the socket is
not open, when more than `maxBufferedBytes` are unsent, or when frames arrive faster than `maxHz`. It
reconnects with exponential backoff and jitter until `close()`.

```ts
const stream = new StreamClient("ws://localhost:8765", { maxHz: 60 });
```

| Option | Default | Meaning |
|---|---|---|
| `maxHz` | `60` | Upper bound on frames per second; `0` = no cap. |
| `maxBufferedBytes` | `65536` | Drop frames while the socket has more unsent bytes than this. |
| `precision` | `4` | Decimal places kept for every number in the JSON. |
| `minBackoffMs`, `maxBackoffMs` | `500`, `10000` | First and largest reconnect delay. |
| `WebSocketImpl`, `now` | browser `WebSocket`, `performance.now` | For tests and non-browser hosts. |

| Member | Description |
|---|---|
| `connect()` | Starts connecting and keeps reconnecting until `close()`. Safe to call repeatedly. |
| `send(frame)` | Sends or drops one frame; returns whether it was sent. |
| `close()` | Disconnects and stops reconnecting. |
| `encode(frame)` | The compact JSON string that `send()` would transmit. |
| `state`, `onState` | `"idle"`, `"connecting"`, `"open"` or `"error"`, and a callback on change. |
| `stats` | `{ sent, dropped, reconnects }`. |
| `url` | The bridge URL (default `ws://localhost:8765`). |

## VrmAvatar (`likeness/vrm`)

Loads a VRM 0.x or 1.0 model with @pixiv/three-vrm and drives it. Details, mapping tables and lighting
advice: [vrm.md](vrm.md).

| Member | Description |
|---|---|
| `VrmAvatar.load(source)` | `source`: URL string, `File` or `ArrayBuffer`. Throws for glTF files without a VRM extension. |
| `VrmAvatar.fromVrm(vrm)` | Wraps a VRM you loaded yourself (`GLTFLoader` + `VRMLoaderPlugin`). Don't call `VRMUtils.rotateVRM0` yourself. |
| `scene` | Wrapper group to add to your scene. Its local frame is the LikenessFrame camera frame; feet at the origin, facing +z. Don't put it under a negatively scaled (mirrored) parent. |
| `apply(frame, dt, options?)` | Drives expressions, head, neck, eyes, arms and fingers. `dt` in seconds (used to fade arms in and out). Allocation-free. |
| `update(dt)` | Advances three-vrm (bones to mesh, look-at, expressions, spring bones, constraints). Call once per rendered frame. |
| `getHeadPosition(out)` | World position of the head bone, for framing. |
| `meta` | `{ title, author, license, version: "1.0" \| "0.x", modelVersion }`. |
| `perfectSync` | True when the model's ARKit expressions are driven directly. |
| `vrm` | The underlying three-vrm `VRM`. |
| `dispose()` | Removes and frees the model. |

`VrmApplyOptions`: `mirror` (default `false`; selfie view), `emotions` (default `true`; drive
happy/angry/sad/surprised in preset mode), `arms` (default `true`; two-bone arm IK to the tracked wrists).

## Frame helpers

| Export | Description |
|---|---|
| `ARKIT_BLENDSHAPES` | The 52 ARKit names in a fixed order. |
| `HAND_JOINTS` | The 21 MediaPipe hand joint names, in `HandOutput.joints` order. |
| `ictToArkit(ictNames, weights)` | ICT expression weights to a `Record<ArkitName, number>`. |
| `headPose(sim, focalPx)` | Head rotation and position (camera frame) from a camera-to-model similarity. |
| `matToQuat(R)` | Row-major 3x3 rotation to a unit quaternion `[x, y, z, w]` with `w >= 0`. |
| `DEFAULT_HFOV_DEG` | `65`. |
| `DEFAULT_CAMERA` | The default `getUserMedia` video constraints. |
| `defaultDriveOptions` | Default `DriveOptions`. |
| `LandmarkModel` | The landmark-only face model (`LandmarkModel.load(folderUrl)`). |

The frame format and its coordinate conventions are described in the
[Frame format](frame-format.md) and in `src/frame.ts`.

## Data-file location

| Export | Description |
|---|---|
| `setAssetBase(url)` | Folder that contains `ict/` and `hands/`. Call it before creating trackers or avatars. |
| `assetBase()` | The current base. Served as is from `dist/lib` or `dist/standalone`: the `assets/` folder next to the bundle. Re-bundled into an app: `/likeness/` (copy `dist/lib/assets` there). |
| `assetUrl(path)` | `assetBase() + path`, e.g. `assetUrl("ict")`. |
