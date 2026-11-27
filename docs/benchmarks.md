# Benchmarks

Measured on an Apple M5 Pro (48 GB, macOS 27.0.1) in Chromium 156. Raw numbers:
[benchmark-results.json](benchmark-results.json).

## Method

A synthetic camera with ground truth: `examples/benchmark.html` animates the built-in avatar with
a known program (talking at 4.5 Hz, smiles, blinks, brow raises, head yaw ±20° and pitch ±9°), renders it at
1280x720, and feeds the canvas to `LikenessTracker` as a 30 fps `MediaStream` for 20 s. The tracker sees
pixels only, like a webcam, and the outputs are compared with the values that drew the frames (at the
best-fitting lag, since output trails the screen by capture and tracking time).

The runs below are back to back in one session, in a browser window that was in the background: GPU clocks
and frame scheduling vary between sessions, so compare rows with each other, not with other machines.

## Tracking

| Per tracked frame (ms, average / p95) | Face, worker | Face, main thread | Face + hands, worker | Face + hands, main thread |
|---|---|---|---|---|
| MediaPipe face landmarker (`faceDetect`) | 13.4 / 16.5 | 9.4 / 12.3 | 15.7 / 23.4 | 9.7 / 11.9 |
| MediaPipe hand landmarker (`handDetect`) | | | 18.5 / 21.9 | 8.1 / 12.4 |
| likeness solver (`drive`) | 0.15 / 0.3 | 0.19 / 0.2 | 0.17 / 0.3 | 0.15 / 0.2 |
| frame assembly, including `drive` (`frame`) | 0.17 / 0.3 | 0.19 / 0.3 | 0.18 / 0.3 | 0.18 / 0.3 |
| **video frame to `LikenessFrame`** (`trackTotal`) | **13.8 / 16.8** | **9.6 / 12.5** | **16.1 / 23.8** | **12.8 / 22.3** |
| **main-thread time** | **0.3** | **9.6** | **0.3** | **12.8** |
| tracked frame rate (30 fps source) | 29.8 | 28.4 | 29.7 | 26.9 |
| render-loop stalls over 50 ms during the run | 0 | 2 | 0 | 9 |

`worker` is the default: MediaPipe runs in two Web Workers, face and hands in parallel, and the main thread
only wraps each video frame (a GPU-backed `VideoFrame`) and finishes the result, about 0.3 ms. The main-thread
path (`worker: false`, and the fallback) runs both detectors in turn on the main thread, which stalls
rendering and drops frames once hands are on.

Separate runs swing with GPU clocks (the worker runs above came out slower per call than the main-thread
runs). On the same frames, alternating backends frame by frame, face detection costs the same in a worker
(11.9 ms median both ways), and face plus two hands finish in 17.7 ms in parallel workers against 19.6 ms
one after the other (averages 21.8 vs. 22.3 ms): the two models share one GPU, so running them in parallel
helps less than the sum suggests.

The hands runs have no hands in view, so they measure the palm-detection cost. With no hand in view for 15
frames, the tracker looks for hands only every third frame, so `handDetect` runs on a third of the frames
there; it goes back to every frame as soon as a hand shows up.

| Accuracy | Face, worker | Face, main thread |
|---|---|---|
| head yaw error | 1.48° median, 4.21° p95 | 1.55° median, 4.09° p95 |
| correlation with ground truth: `eyeBlinkLeft` | 0.985 | 0.983 |
| correlation: `mouthSmileLeft` | 0.947 | 0.860 |
| correlation: jaw (truth `jawOpen` vs. output `jawOpen + mouthLowerDownLeft`) | 0.763 | 0.781 |

The backends compute the same thing; differences come from which frames each run caught. The synthetic face
is the same ICT model the tracker fits, rendered without hair or real skin, so accuracy on real faces will be
lower; treat these as a regression benchmark, not a claim about people.

## Rendering and loading

| | Before | Now |
|---|---|---|
| `LikenessAvatar` mesh update per tracked frame (real weights, 22 of 57 expressions active) | 1.68 ms | 0.42 ms |
| same, all 57 expressions active (Node) | 1.42 ms | 1.12 ms |
| `ict.bin` download | 10.9 MB (7.25 MB gzip) | 8.5 MB (5.86 MB gzip) |
| `LikenessTracker.create({ hands: true })`, warm cache | 250 ms (main thread) | 150 ms (workers, face and hands load in parallel) |

The mesh update evaluates the sparse expressions straight into the render buffers and skips expressions
under 0.001. `ict.bin` stores vertex indices as 16-bit and expression normal deltas as 8-bit (render only,
under 0.5° of normal error); positions and identities are unchanged.

Node micro-benchmarks (printed by `npm test`, same machine): full-face landmark fit (50 components, 468
landmarks, only used by "Full-face refine") 2.04 ms per frame; face-scan CPU work per accepted view
0.52 ms; SH lighting fit on 1500 samples 1.65 ms.

## Reproduce

Run `npm run dev` (the benchmark imports the sources, so no library build is needed), open
http://localhost:5173/examples/benchmark.html, tick the hands box (and the main-thread box for `worker: false`) if wanted, and press **Run benchmark (20 s)**.
The JSON result is shown on the page and stored in `window.benchmarkResult`.

## Bundle and asset sizes

Measured with `npm run build:lib` (Vite 4.5.14). gzip sizes are `gzip -9`.

| File | Raw | gzip |
|---|---|---|
| `dist/lib/tracking.js` + its chunk (MediaPipe external, no three.js) | 0.5 kB + 65.2 kB | 0.4 kB + 19.8 kB |
| `dist/lib/likeness.js` (adds the renderer; three, MediaPipe external) | 70.7 kB | 22.8 kB |
| `dist/lib/vrm.js` (three-vrm external) | 20.0 kB | 6.9 kB |
| `dist/lib/element.js` + shared `frame-<hash>.js` | 3.2 kB + 2.9 kB | 1.3 kB + 1.2 kB |
| `dist/standalone/tracking.js` + `lib-tracking-<hash>.js` (no MediaPipe, no three.js) | 0.5 kB + 65.2 kB | 0.3 kB + 19.8 kB |
| `assets/detect-worker.js` (MediaPipe's JS, runs in the workers) | 193.9 kB | 49.0 kB |
| `dist/standalone/vision_bundle-<hash>.js` (MediaPipe's JS, loaded only on the main-thread fallback) | 189.0 kB | 47.5 kB |
| `dist/standalone/likeness.js` (renderer) | 96.0 kB | 28.0 kB |
| `dist/standalone/vrm.js` (includes three-vrm) | 227.4 kB | 51.0 kB |
| `dist/standalone/GLTFLoader-<hash>.js` (shared chunk: three.js and loaders, not loaded by `tracking.js`) | 1054.4 kB | 223.5 kB |
| `ict/ict-landmarks.bin` + `.json` (tracking only) | 438 kB + 3.5 kB | 265 kB |
| `ict/ict.bin` + `ict.json` (built-in avatar) | 8.5 MB + 30 kB | 5.9 MB |
| `hands/left.glb` + `right.glb` | 94.6 kB + 94.0 kB | |
| `public/avatars/VRM1_Constraint_Twist_Sample.vrm` (demo only, not in the package) | 10.8 MB | |

Tracking only (`tracking.js`) puts about 66 kB (20 kB gzip) of script on the main thread; the workers load
`detect-worker.js` (194 kB, 49 kB gzip), once, in parallel. The renderer entries also load the shared
three.js chunk, about 1.4 MB raw (320 kB gzip) in total for `likeness.js`. MediaPipe's wasm and models come
on top, from their CDNs or your server.
