# The frame format

Every consumer sees the same `LikenessFrame` (`src/frame.ts`), format version 1:

```jsonc
{
  "v": 1,                       // format version
  "t": 23438.2,                 // ms, monotonic clock of the source (performance.now())
  "face": {                     // null when no face is in view
    "blendshapes": {            // all 52 ARKit names, 0..1, after calibration, lip fit and smoothing
      "browDownLeft": 0.012, "eyeBlinkLeft": 0.831, "jawOpen": 0.274, "mouthSmileLeft": 0.62,
      "tongueOut": 0            // ... 52 keys in total
    },
    "head": {
      "rotation": [0.031, -0.152, 0.008, 0.988],   // quaternion [x, y, z, w]
      "position": [0.012, 0.035, -0.58]            // metres; z < 0 is in front of the camera
    },
    "calibrated": true          // neutral-face calibration finished
  },
  "hands": [                    // 0, 1 or 2 entries; empty when hand tracking is off
    { "side": "left", "score": 0.97, "joints": [[0.18, -0.12, -0.52], /* ... 21 joints */] }
  ]
}
```

Conventions ("subject space", never mirrored):

- **Camera frame**, right-handed, metres, origin at the camera. `+x` points to the right of the
  *unmirrored* camera image, which is the **subject's left**; `+y` is up; `+z` points from the subject
  towards the camera, so the subject is at negative z.
- `head.rotation` is the head's orientation in that frame. Identity means looking straight into the camera;
  a positive rotation about `+y` turns the face towards `+x` (the subject's own left).
- `head.position` is the approximate head centre (about 6 cm behind the face surface). Its depth comes from
  the assumed camera field of view (65° horizontal by default, option `hfov`).
- `left` / `right`, in hand sides and blendshape names, always mean the subject's own left and right.
- Hand joints follow MediaPipe's order (`HAND_JOINTS`: `wrist`, `thumbCmc` ... `pinkyTip`).
- Mirroring is the consumer's choice: `LikenessAvatar` (`mirror`), `VrmAvatar.apply(..., { mirror })` and
  the bridge (`--mirror`) each do it in one place.

`StreamClient` rounds every number to 4 decimals, so a face-plus-hands frame is about 2 to 3 KB of JSON.
