# How it works

This page explains the methods behind likeness. For the module map and data flow, see
[architecture.md](architecture.md).


## Face model

 [ICT-FaceKit](https://github.com/ICT-VGL/ICT-FaceKit) is a linear morphable model: a
neutral mesh (26,719 vertices), identity PCA components (the first 20 of 100 are converted) and expression
blendshapes named after ARKit's. likeness keeps 57 expressions: the 52 ARKit shapes, with `browInnerUp`
and `cheekPuff` split per side and no `tongueOut`, plus pupil dilation and cheek raisers. The converter
stores expressions as sparse int16 position deltas and int8 normal deltas, and the renderer evaluates
`neutral + Σ identity + Σ w·expression` on the CPU each frame, touching only the vertices each active
expression moves.

## Landmark embedding

 The converter aligns MediaPipe's canonical face mesh to the ICT face with a
trimmed similarity ICP (Umeyama, 90% inliers, scale clamped), then projects each of the 468 canonical
landmarks to its closest point on the ICT skin and stores the triangle and barycentric coordinates
(median residual 0.89 mm, p95 3.6 mm). Sampling every basis at those points gives a landmark-only copy of
the model (`ict-landmarks.*`, 0.4 MB), which is all the tracker needs. So tracking never touches the
26k-vertex render mesh, and the same expression weights drive the ICT head, a VRM or a VMC app.

## Per frame (`FaceDriver`, `src/driver.ts`)

1. *Scores to prior.* MediaPipe's 52 blendshape scores map one-to-one onto ICT names. The neutral baseline
   captured during calibration is subtracted and rescaled (`(s − b) / (1 − b)`), then per-channel gains apply,
   with an extra mouth gain because MediaPipe under-reports mouth shapes during speech.
2. *Head pose.* A weighted similarity transform (Horn's closed-form quaternion method) aligns 21 stable
   upper-face landmarks (nose bridge, eye corners, forehead, temples) to the model. Its rotation is the
   head orientation. Its scale, with a pinhole camera of the assumed field of view, gives head depth.
3. *Calibration.* The first 45 face frames are averaged into a neutral score baseline and a neutral landmark
   shape, both in the model frame.
4. *Lip-sync fit.* Speech produces small score changes but clear landmark motion. With the observed landmarks
   aligned into the model frame, the mouth and jaw weights `w` are re-solved from lip and chin motion
   relative to the calibrated neutral, `y = g·(aligned − neutral) − (what non-mouth shapes explain)`:

   `min_w ‖W^½ (B w − y)‖² + Σ_a D_a (λ s_a w_a² + μ (w_a − p_a)²)` subject to `0 ≤ w ≤ 1`

   `B` holds the mouth and jaw blendshape deltas at the lip and chin landmarks, `p` is the score prior from
   step 1, `D_a = (BᵀWB)_aa` is a per-shape Jacobi scaling, so the ridge and prior terms are relative to how
   much each shape moves the landmarks (a 3 mm lip shape is not drowned out by `jawOpen`'s 35 mm), and the
   box constraints are enforced with a few active-set passes over a Cholesky solve. Depth residuals count at
   ¼ weight (MediaPipe's z is noisy), face-oval landmarks less than lips, and sideways jaw and mouth shapes
   get a 40x larger ridge (`s_a`) so they cannot soak up fitting error.
5. *Mic speech assist* (optional). Speech-band (300 to 3400 Hz) energy above an adaptive noise floor can open
   `jawOpen` and `mouthLowerDown` when the camera under-reports them. It only opens, never closes.
6. *Filtering.* A One Euro filter (Casiez et al. 2012) per expression smooths a still face without lagging
   motion: mouth shapes use a 6 Hz minimum cutoff and a 6 Hz derivative cutoff, so 4 to 6 syllables per
   second survive; the rest use 1.2 Hz. The `smoothing` option scales all cutoffs.

The output is converted back to the 52 ARKit names (ICT's split halves averaged, `tongueOut` always 0) and
packed into a `LikenessFrame` with the head pose.

## Hands

 MediaPipe's hand landmarker gives image landmarks and metric, hand-centred world landmarks.
The world landmarks already have the camera's axes, so only their translation is unknown, and under full
perspective that is linear in the 21 projections (`u (T_z + w_z) = T_x + w_x`, likewise for `v`): a small
least-squares solve places each hand in the camera frame and stays right when the palm tilts or sits
off-axis. Depth, palm position and hand shape are then smoothed with separate One Euro filters. Two hands with the same handedness label are disambiguated by score.
Finally the fingers are made anatomically plausible, because MediaPipe's per-joint depth is its noisiest output and
shows up as fingers bending sideways or backwards: the PIP and DIP joints are treated as hinges (the outer segments are
projected onto each finger's bending plane), hyperextension is straightened, bends are capped (115° PIP, 90° DIP),
and the DIP follows the PIP part of the way, as in real fingers. Segment lengths are preserved, and the thumb is left as tracked.

## Face scan (`LikenessAvatar.scanFace`, `src/bake.ts`)

- *Identity fit.* After a fresh calibration, a bounded, ridge-regularised fit of the identity coefficients
  to the neutral landmarks (all 468 points, coefficients kept within ±3 standard deviations) reshapes both
  the tracker's landmark model and the render mesh.
- *Projective texture baking.* For about 9 s, each tracked frame is rendered into UV space: every skin texel
  projects through the tracked head pose into the video (weak perspective, accurate at arm's length) and
  picks up that colour. Views are blended by how squarely the surface faces the camera, and a depth prepass
  from the camera's viewpoint rejects occluded surfaces (the cheek behind the nose). Frames are skipped
  during fast motion (blur) and strong expressions (blinks, open jaw, big smiles).
- *SH delighting.* Per view, second-order spherical-harmonic shading is fitted per RGB channel to clean skin
  samples (front-facing, unoccluded; robust IRLS with a Tukey biweight, ridge on bands 1 and 2). Texels are
  divided by the normalised shading and accumulated as linear albedo. Normalising by the first accepted
  view's brightness cancels exposure and white-balance drift between frames.
- *Resolve* (about 1 Hz): per-texel average; a *symmetry fill* blends poorly seen texels with their mirror
  texel across the face's left/right symmetry, weighted so well-observed texels are never overwritten; a
  halo-free unsharp mask; and a feathered fill of never-seen texels towards the median skin tone of the
  cheeks and forehead. ICT's face and head UDIM tiles are packed into one 2048x1024 texture.

## Rendering

 One mesh with a material per ICT part; eyelash cards, cornea shell, eye occlusion and tear
film are hidden because they read as solid geometry without ICT's textures. Iris and pupil are vertex colours.
Skin uses three.js standard/physical materials with shader patches for per-channel wrap lighting (a cheap subsurface
stand-in), mouth-cavity and eye-corner occlusion.
