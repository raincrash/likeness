# Hosting

## Without a bundler

`npm run build:lib` writes `dist/standalone/`: `likeness.js`, `tracking.js`, `element.js`, `vrm.js`, shared
chunks and an `assets/` folder with the data files. Copy the whole folder into your site and import from it
with a plain `<script type="module">`. Keep `assets/` next to the scripts; nothing else needs configuring.

```html
<script type="module">
  import { LikenessTracker } from "./likeness/tracking.js"; // your copy of dist/standalone
</script>
```

## From a local checkout

```bash
cd path/to/likeness && npm install            # builds dist/
cd my-app && npm install path/to/likeness three
```

npm links the folder instead of copying it, so rerun `npm run build:lib` in likeness after changing it.
The linked folder has its own `three` (a dev dependency); make your bundler use a single copy, for example
in Vite: `resolve: { dedupe: ["three"] }`.

## Data files

likeness fetches data files at runtime:

| Files | Needed by | Size |
|---|---|---|
| `ict/ict-landmarks.json`, `ict/ict-landmarks.bin` | `LikenessTracker` | 3.5 kB + 438 kB |
| `ict/ict.json`, `ict/ict.bin` | `LikenessAvatar` (and so `<likeness-avatar>`) | 30 kB + 8.5 MB |
| `hands/left.glb`, `hands/right.glb` | `LikenessAvatar` hand rendering, loaded on first hand | 95 kB + 94 kB |
| `detect-worker.js` | `LikenessTracker`: runs MediaPipe in a Web Worker (it bundles MediaPipe's JS) | 194 kB (49 kB gzip) |

The build copies them to `dist/lib/assets/` and `dist/standalone/assets/`.

- **Plain `<script type="module">` from `dist/standalone` (or `dist/lib`) served as is:** the library finds
  the `assets/` folder next to its own script. Nothing to configure.
- **With a bundler** (Vite, webpack, ...): the library's code ends up in your bundle, so it defaults to
  `/likeness/`. Copy the files there once:

```bash
cp -r node_modules/likeness/dist/lib/assets public/likeness
```

To serve them from somewhere else, call `setAssetBase()` before creating anything:

```ts
import { setAssetBase } from "likeness/tracking";
setAssetBase("/static/likeness/");   // expects <base>ict/... and <base>hands/...
```

If the files are missing, `create()` rejects with an error that says which URL it tried.

Or pass folders per object: `LikenessTracker.create({ modelUrl })`, `LikenessAvatar.create({ modelUrl, handsUrl })`,
or the `model-url` / `hands-url` attributes. A tracking-only app needs just the two `ict-landmarks.*` files.

## MediaPipe files

MediaPipe's wasm runtime and `.task` models are not bundled. By default they are downloaded at runtime:
the wasm from jsDelivr (`@mediapipe/tasks-vision@1.2.3`, the pinned version) and the models from Google's
model storage. Only these files are downloaded; nothing is uploaded. To self-host (offline use, strict CSP),
copy `node_modules/@mediapipe/tasks-vision/wasm/`, download `face_landmarker.task` and
`hand_landmarker.task`, and pass:

```ts
const tracker = await LikenessTracker.create({
  wasmUrl: "/mediapipe/wasm",
  faceModelUrl: "/mediapipe/face_landmarker.task",
  handModelUrl: "/mediapipe/hand_landmarker.task",
});
```

The workers load MediaPipe's ES-module wasm build (`vision_wasm_module_internal.*`, in the same folder); the
main-thread fallback loads `vision_wasm_internal.*`. Copy the whole folder.

With a Content Security Policy, allow the worker script (`worker-src 'self'`, or wherever `detect-worker.js`
lives). If the worker can't start, the tracker falls back to the main thread and logs a warning.

Pages need a secure context for camera access: `https://` or `localhost`.
