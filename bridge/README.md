# likeness-bridge

Drive **your own avatar** with likeness tracking. The browser sends one `LikenessFrame`
(`src/frame.ts`) per tracked video frame to this small local Node program, which then:

- **re-broadcasts it as JSON** over WebSocket to every other connected client (your Unity,
  Unreal, Godot, Python or JS code), and
- **sends it as VMC protocol** (OSC over UDP) to VSeeFace, VNyan, Warudo, VMagicMirror,
  EVMC4U (Unity) and VMC4B (Blender).

```
browser (likeness + StreamClient) ──ws://localhost:8765──► likeness-bridge ─┬─► other WS clients (JSON)
                                                                            ├─► VMC receiver, udp 127.0.0.1:39539
                                                                            └─► stdout, JSON lines (--log)
```

Needs Node 16 or newer. The only dependency is [`ws`](https://github.com/websockets/ws).

## Run

```bash
npm run bridge                          # same as: node bridge/likeness-bridge.mjs
npm run bridge -- --mirror --vmc 127.0.0.1:39540
npx likeness-bridge --help              # via the package.json "bin" entry
```

Then open likeness, start the webcam and turn on streaming (see *Browser side* below). The
bridge prints a banner, connect/disconnect events and a frames/s line every 10 s.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `8765` | WebSocket port. `0` picks a free one. |
| `--host <addr>` | loopback | Bind address. By default the bridge listens on 127.0.0.1 and ::1 only. `--host 0.0.0.0` accepts other machines, and then anyone on your network can read your face data. |
| `--allow-origin <url>` | | Also accept browser pages from this origin (repeatable), e.g. a hosted copy of likeness. |
| `--allow-any-origin` | off | Accept any web page. Not recommended: any site open in your browser could then read the stream. |
| `--vmc <host:port>` | `127.0.0.1:39539` | VMC destination. `[::1]:39539` works for IPv6. |
| `--no-vmc` | | Don't send VMC (WebSocket/JSON only). |
| `--mirror` | off | Mirror the performer (see *Mirroring*). |
| `--blend-case <c>` | `pascal` | ARKit names over VMC: `pascal` (`JawOpen`), `camel` (`jawOpen`) or `both`. |
| `--blendshapes <set>` | `all` | `all`, `arkit` (52 perfect-sync shapes only) or `vrm` (17 VRM presets only). |
| `--no-emotions` | | Send Joy, Angry, Sorrow and Fun as 0. |
| `--no-hands` | | Don't send hand and finger bones. |
| `--neck <0..1>` | `0.3` | Share of the head rotation on the Neck bone; Head gets the rest. |
| `--root-motion` | off | Move the VMC root with your head (relative to where it was in the first frame). Off: the root is sent at the origin, unrotated. |
| `--no-bundles` | | One UDP packet per OSC message, for receivers that can't read bundles. |
| `--log` | off | Write every accepted frame as one JSON line on stdout. Status goes to stderr, so `npm run bridge -- --log \| your-program` works. |
| `--quiet` | | Only the banner and errors. |

### Sources, consumers and robustness

- Any client that sends a valid frame is a **source**. If several browser tabs send, the most
  recently connected one wins. An older source takes over again once the newer one has been silent
  for 1 s or has disconnected.
- Every accepted frame goes to **all other** clients as JSON (the same `LikenessFrame` shape,
  validated: missing blendshapes filled with 0, values clamped to 0..1, quaternion normalised).
  A consumer that falls behind by more than 1 MiB of unsent data is skipped until it catches up.
- Malformed messages (not JSON, `v` other than 1, wrong array lengths, non-finite numbers, binary
  data, over 256 KiB) are dropped and reported on stderr (rate-limited).
- Web pages are only accepted from `localhost`, `*.localhost`, `127.0.0.1` and `[::1]` origins
  unless you add `--allow-origin`. Native clients send no `Origin` header and are always accepted.

## Browser side

`src/stream.ts` exports `StreamClient`:

```ts
import { StreamClient } from "./stream";

const stream = new StreamClient("ws://localhost:8765", { maxHz: 60 });
stream.onState = (s) => console.log("bridge:", s); // "idle" | "connecting" | "open" | "error"
stream.connect();          // reconnects by itself (0.5 s, 1 s, 2 s ... 10 s, with jitter)
stream.send(frame);        // per frame; returns false if dropped
stream.close();
```

It never queues: a frame is dropped when the socket isn't open, when `bufferedAmount` is over
64 KiB, or when frames come faster than `maxHz` (60 by default, 0 = no cap). Numbers are rounded
to 4 decimals (0.1 mm, 1e-4 weight), so a face+hands frame is about 2 to 3 KB of JSON.

## The JSON stream (custom code)

Each WebSocket text message, and each `--log` line, is one `LikenessFrame`:

```jsonc
{
  "v": 1, "t": 15321.4,                       // ms, monotonic clock of the browser
  "face": {                                   // or null when no face is tracked
    "blendshapes": { "jawOpen": 0.42, "eyeBlinkLeft": 0.03, ... },   // all 52, 0..1
    "head": { "rotation": [x, y, z, w], "position": [x, y, z] },     // camera frame, metres
    "calibrated": true
  },
  "hands": [ { "side": "left", "score": 0.97, "joints": [[x, y, z], ... 21] } ]
}
```

### Python

```python
# pip install websockets
import asyncio, json, websockets

async def main():
    async with websockets.connect("ws://localhost:8765") as ws:
        async for msg in ws:
            f = json.loads(msg)
            if f["face"]:
                print(f"jaw {f['face']['blendshapes']['jawOpen']:.2f}  rot {f['face']['head']['rotation']}")

asyncio.run(main())
```

Or without any WebSocket library: `npm run bridge -- --log | python my_consumer.py`, reading
`json.loads(line)` from stdin.

### JavaScript (Node or browser)

```js
// Node 16: npm i ws, then import WebSocket from "ws". Browsers have WebSocket built in.
const ws = new WebSocket("ws://localhost:8765");
ws.onmessage = (e) => {
  const f = JSON.parse(e.data);
  if (f.face) console.log(f.face.blendshapes.jawOpen.toFixed(2), f.hands.length, "hands");
};
```

### Unity / Unreal with the JSON stream

Use any WebSocket client (Unity: e.g. NativeWebSocket; Unreal: the built-in `WebSockets`
module), parse the JSON, and convert coordinates as described next. If you'd rather not write
code, use VMC: EVMC4U for Unity, or the VMC Live Link plugins for Unreal.

## Coordinate conventions

**likeness frame** (`src/frame.ts`), "subject space", not mirrored:

- Right-handed, metres, origin at the camera.
- `+x` points to the right of the unmirrored camera image, which is the **subject's left**. `+y` is up.
  `+z` points from the subject towards the camera, so the subject is at negative z.
- `head.rotation` is the head's orientation in that frame, quaternion `[x, y, z, w]`. Identity means
  looking straight into the camera. A positive rotation about `+y` turns the face towards `+x`, so
  the subject turns to **their own left**.
- `left`/`right` (hands, blendshape names) always mean the subject's own left and right.

**VMC / Unity**: left-handed, metres, `+y` up. The avatar stands at the origin facing `+z`
(towards the default camera), so `+x` is the **avatar's right**. `/VMC/Ext/Bone/Pos` carries
**local** pose relative to the parent bone, and identity is the bone's rest pose. EVMC4U writes the
values straight into `Transform.localPosition` / `localRotation` with no axis conversion, which
confirms the convention.

The avatar faces the camera, as the subject does. The subject's left (`+x`) is the avatar's left
(`-x` in Unity), forward (`+z`) stays forward and up stays up. So the conversion is a reflection
of x:

| | likeness → VMC (default) | likeness → VMC with `--mirror` |
|---|---|---|
| point / position | `(x, y, z) → (-x, y, z)` | `(x, y, z) → (x, y, z)` |
| quaternion `[x, y, z, w]` | `→ [x, -y, -z, w]` | unchanged |
| hands | `left → Left*` bones | `left → Right*` bones |
| blendshapes | unchanged | `…Left ↔ …Right` |

Reflecting the x axis keeps a quaternion's x component and negates y and z. (`--mirror` reflects
x a second time, which cancels the first.) Checks, all covered by `tests/bridge.test.mjs`:

- Turning your head 30° to your own left, `q = (0, sin 15°, 0, cos 15°)`, becomes
  `(0, −sin 15°, 0, cos 15°)` in Unity: a negative rotation about y, which turns the avatar to its own left.
- Nodding down (positive about x) stays positive about x. That is a nod down in Unity too, because
  the axis flip and the handedness flip cancel.
- Tilting your head (about z, the camera axis) changes sign.

**Head split:** `Neck = q^0.3` and `Head = q^0.7`: the same axis with 30% and 70% of the angle,
so `Neck · Head = q`. Change the split with `--neck`.

**Hands:** the VRM 0.x T-pose has every bone at identity rotation: palm down, fingers pointing out
along the arm (`-x` for the left hand, `+x` for the right), thumb forward at 45°. From the 21 joints,
the bridge builds a palm frame (wrist → middle MCP for the finger axis, pinky MCP → index MCP for the
thumb side) and sends:

- `LeftHand`/`RightHand`: the palm frame's rotation from the T-pose palm. There is no arm tracking,
  so this assumes the lower arm is at rest (see *Limitations*).
- Finger bones (`Proximal` = MCP, thumb CMC; `Intermediate` = PIP, thumb MCP; `Distal` = DIP,
  thumb IP): the smallest rotation that turns the rest direction into the measured segment direction,
  in the parent bone's frame. A finger curling towards the palm rotates about `+z` on the left hand
  and `-z` on the right, as on VRoid models.
- Missing hand: rest pose for that side.

**Bone positions:** VMC requires one. The bridge sends typical adult offsets (for example Head
`(0, 0.08, 0)` and LeftHand `(-0.22, 0, 0)`) because it can't know your avatar's proportions. Most
receivers use rotations only, but EVMC4U applies positions by default. Turn off
*BonePositionSynchronize* on its ExternalReceiver if fingers or the head look stretched.

## Mirroring

The VMC spec does not mention mirroring. A message is simply the avatar's pose: `LeftHand` is the
avatar's own left hand. Mirroring is the performer's choice. VSeeFace, VMagicMirror and most
webcam VTuber apps act like a mirror by default: raise your right hand and the avatar facing you
raises its left. The bridge's default is anatomical (your left = the avatar's left). This matches
the likeness frame and full-body tools. Pass `--mirror` for the mirror-like behaviour streamers
expect. Mirroring happens in one place, so a receiver should not mirror a second time.

## Blendshape names (perfect sync)

VMC blendshape names are **case-sensitive** under the spec, because of UniVRM changes. EVMC4U
compares them lowercase anyway. VRM 0.x perfect-sync models carry the 52 ARKit shapes as
**BlendShapeClips in PascalCase** (`JawOpen`, `EyeBlinkLeft`, `BrowInnerUp`). That is the naming
in hinzka's perfect-sync models and the names VMagicMirror requires. VMagicMirror matches
case-insensitively by default (*Ignore case in Perfect Sync expression names*). ARKit, MediaPipe and
most mesh shape keys use camelCase (`jawOpen`). So:

- `--blend-case pascal` (default): works with VSeeFace/VMagicMirror perfect-sync VRMs and with any
  case-insensitive receiver (EVMC4U).
- `--blend-case camel`: for receivers that match raw mesh shape keys named the ARKit way (some
  Blender/VMC4B setups, custom Unity code with exact matching).
- `--blend-case both`: sends each shape twice (104 messages). Safe when you're unsure. A
  case-insensitive receiver just sets the same clip twice to the same value.

## Blendshape mapping

All 52 ARKit shapes are sent under the same name (PascalCase or camelCase as above), value 0..1,
after likeness's calibration and smoothing. With `--mirror`, `…Left` and `…Right` swap first, and
the presets below are derived from the swapped values.

The 17 VRM 0.x presets are derived from them. `avg(X)` = mean of `XLeft` and `XRight`;
`ramp(v, lo, hi)` = 0 below `lo`, 1 above `hi`, linear in between:

| VRM preset | Formula (from `bridge/vmc.mjs`) | Idea |
|---|---|---|
| `Neutral` | 0 | |
| `A` | `clamp(1.5·jawOpen) · (1 − round) · (1 − 0.5·spread)` | open jaw, lips neither rounded nor spread |
| `I` | `spread · (1 − open) · (1 − round)` | spread lips, closed jaw |
| `U` | `clamp(1.5·mouthPucker) · (1 − open)` | rounded, closed |
| `E` | `0.8 · clamp(spread + avg(mouthLowerDown)) · open · (1 − round)` | spread lips, open jaw |
| `O` | `clamp(1.5·mouthFunnel) · open` | rounded, open |
| `Blink` | `min(eyeBlinkLeft, eyeBlinkRight)` | the part both eyes share |
| `Blink_L` | `eyeBlinkLeft − Blink` | remainder, so Blink + Blink_L ≤ 1 |
| `Blink_R` | `eyeBlinkRight − Blink` | |
| `Joy` | `ramp(avg(mouthSmile), 0.45, 0.85)` | big smile |
| `Fun` | `ramp(avg(mouthSmile), 0.15, 0.45) · (1 − Joy)` | gentle smile |
| `Angry` | `ramp(0.7·avg(browDown) + 0.3·avg(noseSneer), 0.3, 0.7) · (1 − Joy)` | |
| `Sorrow` | `ramp(0.4·browInnerUp + 0.6·avg(mouthFrown), 0.25, 0.6) · (1 − Joy) · (1 − Angry)` | |
| `LookUp` | `avg(eyeLookUp)` | |
| `LookDown` | `avg(eyeLookDown)` | |
| `LookLeft` | `mean(eyeLookOutLeft, eyeLookInRight)` | avatar looks to its own left |
| `LookRight` | `mean(eyeLookInLeft, eyeLookOutRight)` | |

Here `open = ramp(jawOpen, 0.05, 0.35)`, `round = max(mouthFunnel, mouthPucker)` and
`spread = clamp(1.5·avg(mouthStretch) + 0.5·avg(mouthSmile))`. If A+I+U+E+O > 1 they are scaled
down to sum to 1. Everything is clamped to 0..1.

On a perfect-sync model the presets and the ARKit shapes can both move the mouth and eyes (VRoid's
`Joy` also closes the eyes). If that doubles up, use `--blendshapes arkit` for perfect-sync models,
`--blendshapes vrm` for models without ARKit clips, or `--no-emotions`.

## Messages sent per frame

In order, packed into OSC bundles of at most 1500 bytes (about 5 UDP packets per frame):

| Address | Arguments |
|---|---|
| `/VMC/Ext/OK` | `i loaded=1, i calibrationState=3 (calibrated), i calibrationMode=0 (normal), i trackingStatus` (1 with a face, 0 without; V2.7 field, which older receivers ignore) |
| `/VMC/Ext/T` | `f` seconds since the bridge started |
| `/VMC/Ext/Root/Pos` | `s "root", f px py pz, f qx qy qz qw` (origin/identity unless `--root-motion`) |
| `/VMC/Ext/Bone/Pos` | `s name, f px py pz, f qx qy qz qw` for `Neck`, `Head` (with a face), and `LeftHand`, `RightHand` plus 30 finger bones `LeftThumbProximal` … `RightLittleDistal` (unless `--no-hands`) |
| `/VMC/Ext/Blend/Val` | `s name, f value`: 17 VRM presets, then 52 ARKit shapes (with a face) |
| `/VMC/Ext/Blend/Apply` | none; always last |

With no face in view, the head and blendshape messages are skipped, so receivers hold the last
expression.

## Recipes

### VSeeFace
*General settings → OSC/VMC receiver*: enable it, port **39539**. Untick everything you don't want
VSeeFace's own tracking to override. With a perfect-sync model, keep the default
`--blend-case pascal`. For the usual mirror-like behaviour: `npm run bridge -- --mirror`.
(If you also run VSeeFace's VMC *sender*, give it a different port.)

### VNyan
*Settings → VMC / OSC receiver*: add a VMC receiver on port 39539, then enable the head, hands and
blendshape layers you want from it. Try `--blend-case both` if ARKit shapes don't move.

### Warudo
Add a *VMC Receiver* (or the *VMC* face/pose tracking blueprint in setup) on port 39539. Warudo
names ARKit shapes camelCase on ARKit-compatible models, so start with `--blend-case both`.

### VMagicMirror
VMagicMirror sends VMC by default. For receiving, open *Ex Tracker / VMC Protocol* and add a
receiver on 39539. Perfect sync expects PascalCase (the default here), and its *Ignore case*
option is on by default.

### Unity (EVMC4U)
Import EVMC4U and add *ExternalReceiver* to a scene with your VRM. Set *Model* to the avatar and
*Port* to 39539. Turn off *BonePositionSynchronize* (the bridge's bone offsets are generic) and
*RootPositionSynchronize* unless you use `--root-motion`. Blendshape matching is case-insensitive.

### Blender (VMC4B)
Install VMC4B, select the armature, set the receive port to 39539 and start the receiver. Map the
shape keys. If your mesh uses ARKit's camelCase shape-key names, run `--blend-case camel` (or `both`).
VMC4B converts Unity's left-handed y-up space to Blender's right-handed z-up space itself.

### Unreal
Use a VMC Live Link plugin on port 39539, or consume the JSON stream directly (see above).

### Several receivers
One bridge sends VMC to one destination. For a second VMC app, run another bridge with its own
`--port` and `--vmc`, and connect a second `StreamClient` to it. JSON consumers can share any bridge.

## Limitations

- **Not tested against the real apps.** The OSC encoding is byte-checked against the OSC 1.0 spec
  examples. The VMC message layout follows protocol.vmc.info and EVMC4U's receiver source. The
  coordinate conversion is checked with known rotations. Behaviour inside VSeeFace, VNyan, Warudo,
  VMagicMirror and VMC4B, including their menu names in the recipes, is unverified.
- **No arms.** likeness tracks hands without elbows, so `LeftHand`/`RightHand` rotate as if the
  arms were in T-pose. Use `--no-hands` if the receiver tracks arms itself, or if a wrist rotating
  on a T-posed arm looks wrong.
- Rest poses assume a VRM 0.x (normalised) skeleton, where every bone is identity in T-pose.
  Non-normalised rigs (raw FBX, VRM 1.0 un-normalised) need their own rest offsets.
- Finger rotations are swing-only (no twist), and the T-pose thumb is assumed to point 45° forward.
- The viseme and emotion presets are heuristics tuned on paper, not against recordings.
- One VMC destination per bridge, and nothing is sent back to the browser.
