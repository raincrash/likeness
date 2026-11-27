# Hand models

`left.glb` and `right.glb` are the WebXR Input Profiles "generic-hand" models, copied unchanged from
the npm package `@webxr-input-profiles/assets@1.0.20`
(`dist/profiles/generic-hand/`, tarball https://registry.npmjs.org/@webxr-input-profiles/assets/-/assets-1.0.20.tgz),
published from https://github.com/immersive-web/webxr-input-profiles. They are the same models three.js's
`XRHandMeshModel` loads from a CDN; likeness serves them locally instead.

Licence: MIT, Copyright (c) 2019 Amazon. See `LICENSE` (the package's `LICENSE.md`).

Each file has one skinned mesh (1360 vertices, 2314 triangles) and 25 bones named after the WebXR
hand joints (`wrist`, `thumb-metacarpal`, ..., `pinky-finger-tip`), all direct children of
`Armature`. In each bone's frame, -Z points along the bone towards the fingertip and +Y out of the
back of the hand. The bind pose equals the rest pose of the nodes.
