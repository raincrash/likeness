# The demo app

`npm run dev` serves `index.html`, a UI around the library (`src/demo/`). `npm run build` writes a static
copy to `dist/app/` that you can host yourself on any HTTPS server (it includes the 10.8 MB sample VRM).

- **Sources:** webcam, a video file, or **No camera? Try a demo face**, an off-screen copy of the built-in
  head animated with talking, smiles, blinks, head motion and two hands (an open palm and a peace sign), streamed into the real tracker like a camera.
- **Avatar tab:** mirror, wireframe, background (studio, transparent for OBS, green screen, plain dark),
  **Load VRM** from disk or **Try sample VRM**, face-scan texture download and reset, identity sliders
  (the first 10 shape components) with randomise and reset.
- **Tracking tab:** hands, lip-sync fit, **mic speech assist**, full-face refine, head pose on/off,
  recalibrate neutral, response sliders (expression, mouth and lip gains, lip prior, smoothing, mic gain)
  and live bars of the strongest expressions.
- **Stream tab:** bridge URL, connect/disconnect and a live preview of the frame JSON.
- **Debug tab:** landmark overlay on the webcam preview, per-stage timings (average and p95), status.
- **Scan my face:** about 10 s; hold still with a relaxed face, then turn slowly to each side. Fits your
  head shape and bakes your skin into a 2048x1024 texture. Nothing leaves the browser.
- **Record:** saves the avatar view as WebM (or MP4 where WebM is unsupported).
- **Stage mode:** hides all UI for screen capture; Esc exits. For an OBS Browser Source, open
  `http://localhost:5173/?stage&bg=transparent`.

URL parameters: `?autostart` (start the webcam), `?puppet` (start the demo face), `?bg=transparent|studio|<css colour>`,
`?stage`, `?bridge=ws://host:port` (connect to that bridge on load).
