# Benchmarks

Measured on an Apple M5 Pro (48 GB, macOS 27.0.1) in Chromium 156. Raw
numbers: [benchmark-results.json](benchmark-results.json).

## Method

A synthetic camera with ground truth: `examples/benchmark.html` animates the built-in avatar with
a known program (talking at 4.5 Hz, smiles, blinks, brow raises, head yaw ±20° and pitch ±9°), renders it at
1280x720, and feeds the canvas to `LikenessTracker` as a 30 fps `MediaStream` for 20 s. The tracker sees
pixels only, like a webcam, and the outputs are compared with the values that drew each frame.

| Per tracked frame (ms, average / p95) | Face only | Face + hands |
|---|---|---|
| MediaPipe face landmarker (`faceDetect`) | 7.05 / 9.9 | 6.33 / 7.8 |
| MediaPipe hand landmarker (`handDetect`) | | 7.02 / 10.1 |
| likeness solver: calibration, alignment, lip fit, filter (`drive`) | 0.09 / 0.2 | 0.07 / 0.2 |
| frame assembly, including `drive` (`frame`) | 0.14 / 0.2 | |
| **total** (`trackTotal`) | **7.19 / 10.0** | **13.44 / 18.4** |
| tracked frame rate (30 fps source) | 29.9 fps | 26.1 fps |

| Accuracy (face only) | Value |
|---|---|
| head yaw error | 1.93° median, 4.48° p95 |
| correlation with ground truth: `eyeBlinkLeft` | 0.983 |
| correlation: `mouthSmileLeft` | 0.933 |
| correlation: jaw (truth `jawOpen` vs. output `jawOpen + mouthLowerDownLeft`) | 0.798 |

Notes: averages are exponential moving averages from the tracker's `perf` counters. The hands run had no
hands in view, so it measures the palm-detection cost. The synthetic face is the same ICT model the tracker
fits, rendered without hair or real skin, so accuracy on real faces will be lower; treat these as a
regression benchmark, not a claim about people.

Node micro-benchmarks (printed by `npm test`, same machine): full-face landmark fit (50 components, 468
landmarks, only used by "Full-face refine") 2.04 ms per frame; face-scan CPU work per accepted view
0.52 ms; SH lighting fit on 1500 samples 1.65 ms.

## Reproduce

Run `npm run dev` (the benchmark imports the sources, so no library build is needed), open
http://localhost:5173/examples/benchmark.html, tick the hands box if wanted, and press **Run benchmark (20 s)**.
The JSON result is shown on the page and stored in `window.benchmarkResult`.

## Bundle and asset sizes

Measured with `npm run build:lib` (Vite 4.5.14). gzip sizes are `gzip -9`.

| File | Raw | gzip |
|---|---|---|
| `dist/lib/tracking.js` + its chunk (MediaPipe external, no three.js) | 0.6 kB + 54.7 kB | 0.4 kB + 16.5 kB |
| `dist/lib/likeness.js` (adds the renderer; three, MediaPipe external) | 67.8 kB | 21.8 kB |
| `dist/lib/vrm.js` (three-vrm external) | 18.3 kB | 6.2 kB |
| `dist/lib/element.js` + shared `frame-<hash>.js` | 3.3 kB + 2.8 kB | 1.3 kB + 1.1 kB |
| `dist/standalone/tracking.js` + `lib-tracking-<hash>.js` (includes MediaPipe's JS, no three.js) | 0.5 kB + 243.8 kB | 0.3 kB + 63.7 kB |
| `dist/standalone/likeness.js` (renderer) | 93.2 kB | 27.0 kB |
| `dist/standalone/vrm.js` (includes three-vrm) | 225.7 kB | 50.3 kB |
| `dist/standalone/GLTFLoader-<hash>.js` (shared chunk: three.js and loaders, not loaded by `tracking.js`) | 1054.4 kB | 223.5 kB |
| `ict/ict-landmarks.bin` + `.json` (tracking only) | 438 kB + 3.5 kB | 265 kB |
| `ict/ict.bin` + `ict.json` (built-in avatar) | 10.9 MB + 30 kB | 7.2 MB |
| `hands/left.glb` + `right.glb` | 94.6 kB + 94.0 kB | |
| `public/avatars/VRM1_Constraint_Twist_Sample.vrm` (demo only, not in the package) | 10.8 MB | |

Tracking only (`tracking.js`) loads about 245 kB (64 kB gzip) of script. The renderer entries also load the
shared three.js chunk, about 1.39 MB raw (315 kB gzip) in total for `likeness.js`. MediaPipe's wasm and models
come on top, from their CDNs or your server.
