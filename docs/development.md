# Development

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Demo app with hot reload at http://localhost:5173 |
| `npm test` | Node test suite (no browser or camera needed) |
| `npm run build` | Type-check and build the demo app to `dist/app/` |
| `npm run build:lib` | Build the library: `dist/lib` (ES modules), `dist/standalone` (bundled) and `dist/types` |
| `npm run bridge` | Start the local streaming bridge |

## Repository layout

```
src/
  lib*.ts                              library entry points (likeness, /tracking, /element, /vrm)
  index.ts                             tracking exports re-exported by lib.ts
  tracking.ts                          LikenessTracker
  frame.ts, frameBuilder.ts            LikenessFrame contract, ARKit names, head pose
  driver.ts, solver.ts                 FaceDriver: calibration, alignment, lip fit, One Euro; linear solvers
  tracker.ts, handTracker.ts           MediaPipe face and hand landmarker wrappers
  handMath.ts, handFilter.ts           hand geometry, finger constraints, smoothing (no three.js)
  handRetarget.ts, hands.ts            retargeting onto the rigged hand models, hand rendering
  landmarkModel.ts, ict.ts             landmark-only model, full ICT render model
  avatar.ts, look.ts, skin.ts          LikenessAvatar, lighting and materials, shader patches
  bake.ts, bakecpu.ts, sh.ts           face-scan texture baking, SH lighting fit
  vrm.ts, vrmMapping.ts                VrmAvatar and its pure ARKit to VRM mapping
  stream.ts                            StreamClient (WebSocket sender)
  element.ts                           <likeness-avatar>
  audio.ts, perf.ts, assets.ts         mic speech meter, timings, data-file location
  demo/                                the demo app (main.ts, puppet.ts, vrm-panel.ts, style.css)
bridge/                                likeness-bridge (Node): JSON re-broadcast and VMC over OSC/UDP
examples/                              tracking-only, web-component, remote-viewer, benchmark pages
public/ict/                            converted ICT-FaceKit model (committed)
public/hands/                          WebXR generic-hand models
public/avatars/                        sample VRM (demo only)
tests/                                 Node tests (solver, driver, frame, hands, bake, VRM mapping, stream, OSC, bridge)
tools/convert_ict.py                   ICT-FaceKit converter
assets/canonical_face_model.obj        MediaPipe canonical face mesh (converter input)
docs/                                  API, architecture, VRM notes, benchmark results, screenshots
```

The pages in `examples/` other than `benchmark.html` import from `dist/standalone/`, so run
`npm run build:lib` first, then open them through `npm run dev` (e.g. http://localhost:5173/examples/tracking-only.html).
`remote-viewer.html?bridge=ws://localhost:8765` renders frames that another tab or machine streams through the bridge.

## Tests

```bash
npm test
```

Compiles the TypeScript tests to `.test-build/` and runs them in Node: solver and filter maths, the
driver on synthetic faces, landmark model consistency with the full model, frame conventions, hand maths,
texture-bake CPU parts and SH fitting, the VRM mapping, `StreamClient` backpressure and reconnects, the OSC
encoder against the OSC 1.0 spec examples, and an end-to-end bridge run (sources, consumers, origins, VMC
output and coordinate conversion). No browser or camera is needed.

## Regenerating the face model

The converted model in `public/ict/` is committed, so this is only needed to change the conversion, e.g.
to keep more identity components. It needs Python 3.10+ and [uv](https://docs.astral.sh/uv/) (which
installs numpy and scipy from the script header):

```bash
git clone --depth 1 https://github.com/ICT-VGL/ICT-FaceKit ../ICT-FaceKit
uv run tools/convert_ict.py ../ICT-FaceKit                    # writes public/ict/
uv run tools/convert_ict.py ../ICT-FaceKit --n-identity 40    # more identity components (bigger ict.bin)
```

Other options: `--out <dir>`, `--canonical <obj>` (default `assets/canonical_face_model.obj`) and
`--max-dist-mm` (landmarks farther than this from the ICT surface are dropped; default 10). Run
`npm test` afterwards: the landmark-model test checks `ict-landmarks.*` against `ict.*`.
