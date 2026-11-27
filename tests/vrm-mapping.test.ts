import { ARKIT_BLENDSHAPES, type ArkitName } from "../src/frame.js";
import {
  presetWeights, matchPerfectSync, canonicalExpressionName, mirrorArkitName, mirrorWeights, readBlendshapes,
  MIRROR_PERMUTATION, N_ARKIT, gazeYawPitch, cameraToVrmQuat, quatPow, compileRules, evaluatePresets, PRESET_RULES,
  DRIVEN_PRESETS, PERFECT_SYNC_MIN_MATCHES, type DrivenPreset,
} from "../src/vrmMapping.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}
const fmt = (w: Partial<Record<string, number>>) =>
  Object.entries(w).filter(([, v]) => (v ?? 0) > 0.01).map(([k, v]) => `${k}=${(v as number).toFixed(2)}`).join(" ") || "all 0";
const top = (w: Record<DrivenPreset, number>, among: readonly DrivenPreset[]) =>
  among.reduce((a, b) => (w[b] > w[a] ? b : a));
const VIS: DrivenPreset[] = ["aa", "ih", "ou", "ee", "oh"];
const EMO: DrivenPreset[] = ["happy", "angry", "sad", "surprised"];
const near = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) < eps;

// --- table sanity ---------------------------------------------------------------
check("table covers every driven preset once",
  DRIVEN_PRESETS.every((p) => PRESET_RULES.filter((r) => r.preset === p).length === 1));

// --- ARKit -> presets -----------------------------------------------------------
{
  const w = presetWeights({});
  check("neutral face -> all presets 0", Object.values(w).every((v) => v === 0), fmt(w));
}
{
  const w = presetWeights({ jawOpen: 0.7 });
  check("jawOpen -> aa", top(w, VIS) === "aa" && w.aa > 0.6 && EMO.every((e) => w[e] < 0.05), fmt(w));
}
{
  const w = presetWeights({ mouthPucker: 0.8, jawOpen: 0.05 });
  check("pucker -> ou", top(w, VIS) === "ou" && w.ou > 0.5 && w.aa < 0.1, fmt(w));
}
{
  const w = presetWeights({ mouthFunnel: 0.7, jawOpen: 0.35 });
  check("funnel + open jaw -> oh", top(w, VIS) === "oh" && w.oh > 0.4, fmt(w));
}
{
  const w = presetWeights({ mouthFunnel: 0.7, jawOpen: 0 });
  check("funnel, closed jaw -> no oh", w.oh === 0, fmt(w));
}
{
  const w = presetWeights({ mouthStretchLeft: 0.6, mouthStretchRight: 0.6, jawOpen: 0.25 });
  check("stretch + open -> ee", top(w, VIS) === "ee" && w.ee > 0.5, fmt(w));
}
{
  const w = presetWeights({ mouthStretchLeft: 0.6, mouthStretchRight: 0.6, mouthSmileLeft: 0.3, mouthSmileRight: 0.3 });
  check("stretch with closed mouth -> no ee/ih", w.ee === 0 && w.ih === 0, fmt(w));
}
{
  const w = presetWeights({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5, jawOpen: 0.15 });
  check("smile + slightly open -> ih", w.ih > 0.2, fmt(w));
}
{
  const w = presetWeights({ jawOpen: 1, mouthFunnel: 1, mouthPucker: 1, mouthStretchLeft: 1, mouthStretchRight: 1, mouthSmileLeft: 1, mouthSmileRight: 1 });
  const sum = VIS.reduce((s, v) => s + w[v], 0);
  check("visemes sum to <= 1", sum <= 1 + 1e-5, `sum ${sum.toFixed(3)}`);
}
{
  const w = presetWeights({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 });
  check("both eyes -> blink only", near(w.blink, 0.9) && w.blinkLeft === 0 && w.blinkRight === 0, fmt(w));
}
{
  const w = presetWeights({ eyeBlinkLeft: 1, eyeBlinkRight: 0.2 });
  check("wink left -> blink 0.2 + blinkLeft 0.8", near(w.blink, 0.2) && near(w.blinkLeft, 0.8) && w.blinkRight === 0, fmt(w));
}
{
  const w = presetWeights({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.5, cheekSquintRight: 0.5 });
  check("smile + cheekSquint -> happy", top(w, EMO) === "happy" && w.happy > 0.6, fmt(w));
}
{
  const w = presetWeights({ mouthSmileLeft: 0.15, mouthSmileRight: 0.15 });
  check("faint smile -> no happy", w.happy === 0, fmt(w));
}
{
  const w = presetWeights({ browDownLeft: 0.8, browDownRight: 0.8 });
  check("browDown -> angry", top(w, EMO) === "angry" && w.angry > 0.5, fmt(w));
}
{
  const w = presetWeights({ mouthFrownLeft: 0.7, mouthFrownRight: 0.7, browInnerUp: 0.7 });
  check("frown + browInnerUp -> sad", top(w, EMO) === "sad" && w.sad > 0.5, fmt(w));
}
{
  const w = presetWeights({ browOuterUpLeft: 0.7, browOuterUpRight: 0.7, eyeWideLeft: 0.6, eyeWideRight: 0.6, jawOpen: 0.5, browInnerUp: 0.6 });
  check("brows up + wide eyes + open jaw -> surprised", top(w, EMO) === "surprised" && w.surprised > 0.5, fmt(w));
}
{
  const w = presetWeights({ jawOpen: 0.6 });
  check("talking (jawOpen) alone -> not surprised", w.surprised === 0, fmt(w));
}
{
  // Compiled evaluation reuses its buffers and must give the same answer twice.
  const c = compileRules();
  const a = new Float32Array(N_ARKIT);
  a[ARKIT_BLENDSHAPES.indexOf("jawOpen")] = 0.5;
  const o1 = Array.from(evaluatePresets(c, a, new Float32Array(c.presets.length)));
  const out = new Float32Array(c.presets.length);
  evaluatePresets(c, a, out);
  evaluatePresets(c, a, out);
  check("evaluation is deterministic / stateless", o1.every((v, i) => v === out[i]));
}

// --- perfect sync matching ----------------------------------------------------------
check("canonical: Left / _L / .l / -L agree",
  ["eyeBlinkLeft", "EyeBlink_L", "eyeblink.l", "EYEBLINK-L", "eyeBlink_Left"].every((n) => canonicalExpressionName(n) === "eyeblinkleft"));
check("canonical: Right / _R agree", canonicalExpressionName("mouthSmile_R") === canonicalExpressionName("mouthSmileRight"));
check("canonical: no suffix untouched", canonicalExpressionName("JawOpen") === "jawopen" && canonicalExpressionName("cheekPuff") === "cheekpuff");
{
  const exact = matchPerfectSync([...ARKIT_BLENDSHAPES]);
  check("exact ARKit names -> 52 matches", exact.count === 52 && exact.names.every((n, i) => n === ARKIT_BLENDSHAPES[i]));
}
{
  // Upper-case first letter, ICT-style _L/_R suffixes (as many perfect-sync VRMs use).
  const ict = ARKIT_BLENDSHAPES.map((n) => (n[0].toUpperCase() + n.slice(1)).replace(/Left$/, "_L").replace(/Right$/, "_R"));
  const m = matchPerfectSync(ict);
  const iL = ARKIT_BLENDSHAPES.indexOf("eyeBlinkLeft"), iR = ARKIT_BLENDSHAPES.indexOf("mouthSmileRight");
  check("Capitalised + _L/_R names -> 52 matches", m.count === 52 && m.names[iL] === "EyeBlink_L" && m.names[iR] === "MouthSmile_R",
    `${m.count} matches`);
}
{
  // Exact (case-insensitive) beats suffix-normalised: both "mouthLeft" and "mouth_L" present.
  const m = matchPerfectSync(["mouth_L", "MOUTHLEFT"]);
  check("exact match preferred", m.names[ARKIT_BLENDSHAPES.indexOf("mouthLeft")] === "MOUTHLEFT");
}
{
  const m = matchPerfectSync(["Joy", "Sorrow", "A", "I", "U", "Blink_L", "Blink_R"]);
  check("ordinary VRM 0.x names are not perfect sync", m.count < PERFECT_SYNC_MIN_MATCHES, `${m.count} matches`);
}

// --- mirroring -----------------------------------------------------------------------
check("mirror names", mirrorArkitName("eyeBlinkLeft") === "eyeBlinkRight" && mirrorArkitName("jawRight") === "jawLeft"
  && mirrorArkitName("mouthLeft") === "mouthRight" && mirrorArkitName("jawOpen") === "jawOpen" && mirrorArkitName("browInnerUp") === "browInnerUp");
check("mirror is an involution", Array.from(MIRROR_PERMUTATION).every((j, i) => MIRROR_PERMUTATION[j] === i));
{
  const unpaired = ARKIT_BLENDSHAPES.filter((n) => mirrorArkitName(n) === n);
  check("only centre shapes are unpaired", unpaired.every((n) => !/Left$|Right$/.test(n)), unpaired.join(","));
}
{
  const rec = Object.fromEntries(ARKIT_BLENDSHAPES.map((n) => [n, 0])) as Record<ArkitName, number>;
  rec.eyeBlinkLeft = 1; rec.mouthSmileRight = 0.5; rec.jawLeft = 0.3; rec.jawOpen = 0.4;
  const m = readBlendshapes(rec, new Float32Array(N_ARKIT), true);
  const at = (n: ArkitName) => m[ARKIT_BLENDSHAPES.indexOf(n)];
  check("mirrored read swaps sides", at("eyeBlinkRight") === 1 && at("eyeBlinkLeft") === 0 && at("mouthSmileLeft") === 0.5
    && near(at("jawRight"), 0.3) && near(at("jawOpen"), 0.4));
  const back = mirrorWeights(m, new Float32Array(N_ARKIT));
  check("mirror twice = identity", ARKIT_BLENDSHAPES.every((n, i) => near(back[i], Math.min(1, rec[n]))));
  const plain = presetWeights({ eyeBlinkLeft: 1 });
  const mir = presetWeights(Object.fromEntries(ARKIT_BLENDSHAPES.map((n, i) => [n, mirrorWeights(
    Float32Array.from(ARKIT_BLENDSHAPES, (k) => (k === "eyeBlinkLeft" ? 1 : 0)), new Float32Array(N_ARKIT))[i]])));
  check("mirrored wink -> blinkRight", plain.blinkLeft === 1 && mir.blinkRight === 1 && mir.blinkLeft === 0);
}
{
  const w = new Float32Array(N_ARKIT);
  w[ARKIT_BLENDSHAPES.indexOf("eyeLookOutLeft")] = 0.5;
  w[ARKIT_BLENDSHAPES.indexOf("eyeLookInRight")] = 0.5;
  w[ARKIT_BLENDSHAPES.indexOf("eyeLookUpLeft")] = 0.4;
  w[ARKIT_BLENDSHAPES.indexOf("eyeLookUpRight")] = 0.4;
  const g = gazeYawPitch(w, [0, 0]);
  const gm = gazeYawPitch(mirrorWeights(w, new Float32Array(N_ARKIT)), [0, 0]);
  check("gaze to subject's left -> yaw > 0, up -> pitch < 0", g[0] > 0 && g[1] < 0, `yaw ${g[0].toFixed(1)} pitch ${g[1].toFixed(1)}`);
  check("mirrored gaze flips yaw only", near(gm[0], -g[0]) && near(gm[1], g[1]));
}

// --- rotations -------------------------------------------------------------------------
{
  // Small yaw to the subject's left: rotation about +y.
  const a = 0.4, q = [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  const v1 = cameraToVrmQuat(q, false, false, [0, 0, 0, 0]);
  const vm = cameraToVrmQuat(q, true, false, [0, 0, 0, 0]);
  const v0 = cameraToVrmQuat(q, false, true, [0, 0, 0, 0]);
  check("VRM 1.0 unmirrored = identity mapping", v1.every((x, i) => near(x, q[i])));
  check("mirror reverses yaw", near(vm[1], -q[1]) && near(vm[3], q[3]));
  check("VRM 0.x keeps yaw (y axis is shared)", near(v0[1], q[1]));
  const p = [Math.sin(a / 2), 0, 0, Math.cos(a / 2)]; // pitch (nod) about x
  const p0 = cameraToVrmQuat(p, false, true, [0, 0, 0, 0]), pm = cameraToVrmQuat(p, true, false, [0, 0, 0, 0]);
  check("VRM 0.x flips pitch axis; mirror keeps pitch", near(p0[0], -p[0]) && near(pm[0], p[0]));
  const r = [0, 0, Math.sin(a / 2), Math.cos(a / 2)]; // roll about z
  const rm = cameraToVrmQuat(r, true, false, [0, 0, 0, 0]);
  check("mirror reverses roll", near(rm[2], -r[2]));
  const neg = cameraToVrmQuat([-q[0], -q[1], -q[2], -q[3]], false, false, [0, 0, 0, 0]);
  check("q and -q give the same result", neg.every((x, i) => near(x, q[i])));
  const bad = [cameraToVrmQuat([NaN, 0, 0, 1], false, false, [9, 9, 9, 9]), cameraToVrmQuat([0, 0, 0, 0], true, true, [9, 9, 9, 9])];
  check("NaN or zero quaternion -> identity (no NaN bones)", bad.every((v) => near(v[0], 0) && near(v[1], 0) && near(v[2], 0) && near(v[3], 1)), JSON.stringify(bad));
}
{
  // neck^0.3 * head^0.7 == q
  const ax = [0.3, 0.8, -0.2], n = Math.hypot(...ax), ang = 1.1;
  const q = [...ax.map((x) => (x / n) * Math.sin(ang / 2)), Math.cos(ang / 2)];
  const a = quatPow(q, 0.3, [0, 0, 0, 0]), b = quatPow(q, 0.7, [0, 0, 0, 0]);
  const prod = [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  check("neck/head split recomposes the head rotation", prod.every((x, i) => near(x, q[i])));
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
