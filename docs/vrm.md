# Bring your own avatar (VRM)

likeness can drive any [VRM](https://vrm.dev/en/) avatar, VRM 0.x or 1.0, from its tracking output
(`LikenessFrame`, see `src/frame.ts`). Loading and rendering use
[@pixiv/three-vrm](https://github.com/pixiv/three-vrm) 3.5.5 (MIT).

| File | What it is |
|---|---|
| `src/vrm.ts` | `VrmAvatar`: loads a .vrm and applies frames to it (three.js) |
| `src/vrmMapping.ts` | The pure mapping: ARKit → VRM presets table, perfect-sync matching, mirroring, gaze, quaternion conversion (no three.js, unit tested) |
| `tests/vrm-mapping.test.ts` | Node tests for the mapping (`npm test`) |
| `public/avatars/VRM1_Constraint_Twist_Sample.vrm` | Sample model, VRM Public License 1.0 by pixiv Inc. (see `public/avatars/README.md`) |

## Usage

```ts
import { VrmAvatar } from "likeness/vrm";

const avatar = await VrmAvatar.load(fileOrUrlOrArrayBuffer); // .vrm, VRM 0.x or 1.0
scene.add(avatar.scene);              // add to the scene root, NOT under a mirrored (scale.x = -1) group
avatar.scene.updateMatrixWorld(true);
avatar.scene.position.sub(avatar.getHeadPosition(new THREE.Vector3())); // head bone at the origin

// per tracked frame:
avatar.apply(frame, dt, { mirror: true });   // selfie view
// per rendered frame, before renderer.render():
avatar.update(dt);                           // three-vrm: bones -> mesh, look-at, expressions, spring bones

// later:
avatar.dispose();
```

- `VrmAvatar.load(source: string | File | ArrayBuffer)` throws `Not a VRM file …` for plain glTF.
- `VrmAvatar.fromVrm(vrm)` wraps a VRM you loaded with your own `GLTFLoader` + `VRMLoaderPlugin`.
  Don't call `VRMUtils.rotateVRM0` yourself, because `fromVrm` does it.
- `avatar.meta`: `{ title, author, license, version: "1.0" | "0.x", modelVersion }`. Show the author and
  licence to the user. VRM licences often restrict use (avatar permission, commercial use, credit).
- `avatar.perfectSync`: true when the model's ARKit expressions are driven directly.
- `apply(frame, dt, { mirror?, emotions? = true, arms? = true })`. `dt` (seconds) is only used to fade the
  arms in and out when hands appear or disappear. `apply` creates no JS objects (no `new`, closures or
  arrays). It costs about 7 µs per frame for the face and about 35 µs with both hands (Node 16, measured on the dev machine).
- `avatar.scene` is a wrapper group whose local frame is the LikenessFrame camera frame (x = subject's
  left, y up, z towards the camera), with the avatar's feet at its origin and the avatar facing +z.
  You can move, rotate or scale it freely, because all bone solving happens in world space.

### Mirroring

Mirroring happens inside `apply`, not by negative scaling. A negative scale would flip triangle
winding, which breaks MToon outlines and back-face culling, and it would swap the avatar's left and
right bones. With `mirror: true`, left/right blendshapes are swapped (`eyeBlinkLeft` ↔ `eyeBlinkRight`,
`jawLeft` ↔ `jawRight`, …). The head rotation is reflected across the x = 0 plane (yaw and roll negate),
gaze yaw is reversed, and the subject's left hand drives the avatar's right hand with its joints
reflected.

## Expressions

### Perfect sync

If at least 26 of the 52 ARKit names match the model's **custom** expressions, the model counts as
"perfect sync" and every matched expression is set directly from the ARKit value. No preset is touched
in that mode. Matching is case-insensitive. The exact name wins first; after that, a side suffix of
`Left`/`_L`/`.L`/`-L`/` L` matches any other spelling of the same side (same for Right). So
`eyeBlinkLeft`, `EyeBlink_L` and `eyeblink.l` all drive ARKit `eyeBlinkLeft`. If the model has any
`eyeLook*` expression, the eyes come from those blendshapes and the VRM lookAt is held at 0.

### Preset mapping (all other models)

`weight = clamp01((bias + Σ terms) · Π gates)`, where `open(a–b)` = smoothstep(a, b, jawOpen) and `x`
of a Left/Right pair means the mean of both sides. After that, the five visemes are scaled together
so they sum to at most 1. The table is data (`PRESET_RULES` in `src/vrmMapping.ts`): edit it there.

| VRM preset | Formula |
|---|---|
| aa | 1.2·jawOpen − 0.6·mean(funnel, pucker) − 0.4·stretch |
| ou | 0.9·mouthPucker + 0.4·mouthFunnel |
| oh | (mouthFunnel + 0.2·jawOpen) · open(0.05–0.25) |
| ee | (1.2·mouthStretch + 0.4·mouthSmile) · open(0.03–0.2) |
| ih | (0.6·mouthSmile + 0.3·mouthStretch + 0.3·jawOpen − 0.05) · open(0.02–0.15) |
| blink | min(eyeBlinkLeft, eyeBlinkRight) |
| blinkLeft | eyeBlinkLeft − blink |
| blinkRight | eyeBlinkRight − blink |
| happy | 0.8·mouthSmile + 0.6·cheekSquint − 0.15 |
| angry | browDown + 0.3·noseSneer − 0.15 |
| sad | 0.7·mouthFrown + 0.6·browInnerUp − 0.4·browOuterUp − 0.1 |
| surprised | (0.5·browOuterUp + 0.5·eyeWide + 0.3·jawOpen − 0.1) · browsUp(0.1–0.35) |

`relaxed`, `neutral` and the `look*` presets are not driven (three-vrm drives `look*` itself for
expression-type look-at). Blink is split into a shared part and a one-sided remainder, so `blink` and
`blinkLeft` never stack past 1. Pass `emotions: false` to keep only visemes and blinks.

**VRM 0.x:** three-vrm renames 0.x blend shape presets on load (`a/i/u/e/o` → `aa/ih/ou/ee/oh`,
`joy` → `happy`, `sorrow` → `sad`, `fun` → `relaxed`, `blink_l/blink_r` → `blinkLeft/blinkRight`,
`lookup` → `lookUp`, …). 0.x groups with preset `unknown` become custom expressions under their name,
and that is where perfect-sync 0.x models keep their ARKit shapes. So one table covers both versions.
Presets a model lacks are skipped.

## Head and neck

The head quaternion is converted to the VRM humanoid frame. The LikenessFrame camera frame *is* the
VRM 1.0 model frame (faces +z, its left is +x). VRM 0.x faces −z: `VRMUtils.rotateVRM0` turns its scene
180° about y, so its normalized bone rotations are conjugated by that turn, `(x, y, z, w) → (−x, y, −z, w)`.
The rotation is split between the normalized `neck` and `head` bones as q^0.3 and q^0.7 (same axis,
so they recompose exactly to q). A model without a neck gets everything on the head. The spine is
not moved, and head translation is not applied to the body.

## Eyes

Gaze is `yaw = 30°·(eyeLookOutLeft + eyeLookInRight − eyeLookInLeft − eyeLookOutRight)/2` and
`pitch = −25°·(up − down)/2`, written to `vrm.lookAt.yaw/pitch` in three-vrm's convention (yaw > 0 looks
towards the avatar's left, pitch < 0 looks up). The model's own lookAt range maps then decide how far
the eye bones or `look*` expressions move.

## Hands and arms

For each avatar hand, the tracked hand of that side is used (the opposite side when mirrored). If both
are reported for one side, the higher score wins.

1. **Wrist orientation.** A palm frame (forward = wrist → middle MCP, across = pinky MCP → index MCP)
   is built from the 21 joints and from the avatar's rest pose (hand, middle/index/little proximal
   bones). The rotation between the two frames is applied to the rest orientation of the hand.
2. **Arms (two-bone IK, `arms: true`).** The wrist target is the avatar's head centre (head bone
   + 8 cm) + (tracked wrist − tracked head centre) × (avatar arm length / 0.55 m). The elbow stays in
   the plane of shoulder, target and a down-back-outward pole. Out-of-reach targets are clamped to
   99.9% of arm length.
3. **Fingers.** Each finger bone (VRM 1.0 names; three-vrm renames VRM 0.x thumbs) gets a minimal-arc
   rotation so its rest direction (towards the next bone, read from the normalized rest pose) points
   along the tracked segment. Segments are expressed relative to the avatar's actual hand, so fingers
   stay correct when `arms: false` or when IK can't match the wrist exactly.
4. **No hands.** Arms hang relaxed (slightly out and forward) and fingers are straight. Arms blend
   between the relaxed and tracked poses over 0.25 s when a hand appears or disappears.

A headless check against the bundled sample (Node, real three-vrm loader, textures stubbed) put the
finger bones, raw and normalized, within 0.1° of the tracked segments. The wrist landed on its target,
the head rotation matched to 0.001°, and mirroring moved winks, gaze and hands to the other side.

## Lighting and colour (important)

VRM materials are usually **MToon**. MToon is toon-shaded, not PBR, and it behaves differently from the
built-in head's look:

- **Every directional light adds its full colour.** MToon uses N·L only to choose between the lit and
  the shade colour, not to scale brightness. The default `look.ts` rig (key 2.4 + fill 0.45 + rims
  1.8 + 1.1 ≈ 5.75) therefore makes MToon about 1.8× too bright, and the back rims flood the face with
  shade colour. Models are authored for roughly one white light of intensity π (three.js physical
  units), which gives exactly the texture colour.
- **`scene.environment` is ignored.** MToon takes ambient only from `AmbientLight`, `HemisphereLight`
  and `LightProbe`. PBR (MeshStandard) parts, which some VRMs have, do use the environment.
- **Tone mapping applies.** MToon includes three's tone-mapping and colour-space chunks, so under
  `NeutralToneMapping` anything above about 0.76 is compressed and desaturated towards white. Together
  with the over-bright rig, skin and hair look pastel and washed out. Set `toneMapped = false` on MToon
  materials for the flat, "as authored" look VRM users expect. Keep `renderer.outputColorSpace =
  SRGBColorSpace` (the default). GLTFLoader already tags colour textures as sRGB.

A rig that matches how VRM apps render (apply while a VRM is shown, restore afterwards):

```ts
const saved: [THREE.Light, number][] = [];
scene.traverse((o) => {
  if ((o as THREE.Light).isLight) { const l = o as THREE.Light; saved.push([l, l.intensity]); l.intensity = 0; }
});
const vrmKey = new THREE.DirectionalLight(0xffffff, Math.PI * 0.8);
vrmKey.position.set(0.5, 1, 1.5);          // from upper front
const vrmAmb = new THREE.AmbientLight(0xffffff, Math.PI * 0.2);
scene.add(vrmKey, vrmAmb);
avatar.scene.traverse((o) => {
  const mats = (o as THREE.Mesh).material;
  for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) if ((m as any).isMToonMaterial) m.toneMapped = false;
});
// restore: saved.forEach(([l, i]) => (l.intensity = i)); vrmKey.removeFromParent(); vrmAmb.removeFromParent();
```

Shadows: VRM meshes don't cast or receive shadows unless you set `castShadow`/`receiveShadow`. The
look rig's shadow box (`shadowExtent` 0.2 m around the origin) only covers the head anyway.

## Sample model

`public/avatars/VRM1_Constraint_Twist_Sample.vrm` (10.8 MB) is the VRM Consortium's VRM 1.0 sample by
pixiv Inc. It is under the VRM Public License 1.0 with `allowRedistribution: true`,
`modification: allowModificationRedistribution`, `commercialUsage: corporation`,
`creditNotation: unnecessary` and `allowAntisocialOrHateUsage: false`. It is **not** MIT. See
`public/avatars/README.md` and `LICENSE`. The VRM Consortium's other sample, Seed-san, is also
redistributable, but it requires credit and was not bundled. Everything under `public/` is copied
into the build, so this file adds 10.8 MB to `dist/`.

Users load their own model from disk with the demo's **Load VRM** button. Nothing is uploaded. Good
sources of models: [VRoid Hub](https://hub.vroid.com/en) (check each model's terms and download
permission), VRoid Studio exports, or the samples in
[vrm-c/vrm-specification](https://github.com/vrm-c/vrm-specification/tree/master/samples).

## Limitations

- **Arm IK is approximate.** The arm scale comes from a fixed 0.55 m human arm. There is no forearm
  twist distribution except what the model's own roll constraints do, the shoulders and spine don't
  move, and hands held far forward or across the body can make the elbow and wrist twist look odd.
  Turn it off with `arms: false`. Fingers keep working.
- **Finger roll** comes from the palm frame only. Finger bones use minimal-arc aiming with no joint
  limits, so tracking noise can bend fingers sideways or backwards.
- **Emotion presets** often carry `overrideMouth`/`overrideBlink` in the model. A strong `happy` then
  silences the visemes or blinks; that's the model's design, not a bug. Use `emotions: false` if it
  gets in the way.
- **Viseme formulas** are heuristics tuned on synthetic inputs, not on recorded speech. MediaPipe's
  mouth shapes are weak during fast speech.
- **Gaze gain** (30° / 25°) and the lookAt range maps differ between models. Some will look too far
  and some barely move.
- **Perfect-sync detection** needs ≥ 26 matching custom expression names. Models with unusual prefixes
  (e.g. `BlendShape.eyeBlinkLeft`) fall back to presets.
- **Allocation:** `apply` creates no objects, but V8 still shows about 1 KB per frame of short-lived
  garbage (number boxing inside three.js maths). That's roughly one minor GC every few thousand
  frames.
- **Spring bones** (hair, clothes) only simulate correctly if `update(dt)` runs every rendered frame
  with a real `dt`.

## What to check visually

1. Load the sample. It should face the camera, with the head at the view centre.
2. Turn your head left, right, up and down, and roll it. The avatar follows the same way unmirrored
   and reversed when mirrored. Repeat with a VRM 0.x model (e.g. a VRoid Studio 0.x export); it must
   not face away or nod the wrong way.
3. Wink each eye. Mirrored, your left wink closes the avatar's eye on the same side of the screen.
4. Say "a, i, u, e, o" and check the visemes. Smile, frown, raise and lower your brows for the emotions.
5. Look left and right without turning your head. The eyes follow.
6. Raise one hand beside your face, palm to the camera, then make a fist, a point and a thumbs-up.
   Check the wrist roll and finger curl on both hands, mirrored and unmirrored.
7. Lower your hands out of view. The arms should relax smoothly.
8. Check the colours with and without the lighting snippet above.
