# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Convert the ICT-FaceKit face model into likeness's browser format.

Writes <out>/ict.bin + <out>/ict.json: the neutral mesh (metres), its vertex
normals, triangles grouped by mesh part, sparse int16 expression deltas (with
matching normal deltas), dense int16 identity deltas, and an embedding of the
468 MediaPipe face-mesh landmarks onto the ICT face surface. Also writes
<out>/ict-landmarks.json + .bin: a landmark-only model (~0.4 MB) for headless
tracking (LandmarkModel in src/landmarkModel.ts).

    uv run tools/convert_ict.py ../ICT-FaceKit [--out public/ict] [--n-identity 20]

ICT-FaceKit is MIT licensed: https://github.com/ICT-VGL/ICT-FaceKit
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent

# Vertex ranges [start, end) from the ICT-FaceKit README topology table.
PARTS: list[tuple[str, int, int]] = [
    ("face", 0, 9409),
    ("head_neck", 9409, 11248),
    ("mouth_socket", 11248, 13294),
    ("eye_socket_left", 13294, 13678),
    ("eye_socket_right", 13678, 14062),
    ("gums_tongue", 14062, 17039),
    ("teeth", 17039, 21451),
    ("sclera_left", 21451, 22221),
    ("iris_left", 22221, 23021),
    ("sclera_right", 23021, 23791),
    ("iris_right", 23791, 24591),
    ("lacrimal_fluid_left", 24591, 24795),
    ("lacrimal_fluid_right", 24795, 24999),
    ("eye_blend_left", 24999, 25023),
    ("eye_blend_right", 25023, 25047),
    ("eye_occlusion_left", 25047, 25199),
    ("eye_occlusion_right", 25199, 25351),
    ("eyelashes_left", 25351, 26035),
    ("eyelashes_right", 26035, 26719),
]
SKIN_PART = "face"  # landmarks are embedded on the face part only
POS_EPS = 2e-5  # metres; deltas under 0.02 mm are invisible
NORMAL_EPS = 2e-3  # ~0.1 degree


# --- OBJ parsing -----------------------------------------------------------

def read_obj_vertices(path: Path) -> np.ndarray:
    """Positions of all `v` lines (they are contiguous in ICT files)."""
    text = path.read_bytes()
    start = text.find(b"\nv ") + 1
    end = text.find(b"\nvt ", start)
    if end < 0:
        end = text.find(b"\nf ", start)
    block = text[start:end].replace(b"v ", b"")
    arr = np.array(block.split(), dtype=np.float64)
    return arr.reshape(-1, 3)


def read_obj_faces(path: Path) -> list[list[int]]:
    faces = []
    for line in path.read_text().splitlines():
        if line.startswith("f "):
            faces.append([int(tok.split("/")[0]) - 1 for tok in line.split()[1:]])
    return faces


def read_obj_faces_vt(path: Path) -> tuple[list[list[int]], list[list[int]], np.ndarray]:
    """Faces as parallel position/vt index lists (0-based) plus the vt array."""
    faces, faces_vt, vts = [], [], []
    for line in path.read_text().splitlines():
        if line.startswith("f "):
            toks = [tok.split("/") for tok in line.split()[1:]]
            faces.append([int(t[0]) - 1 for t in toks])
            faces_vt.append([int(t[1]) - 1 for t in toks])
        elif line.startswith("vt "):
            vts.append(line.split()[1:3])
    return faces, faces_vt, np.asarray(vts, dtype=np.float64)


def triangulate(faces: list[list[int]]) -> np.ndarray:
    tris = []
    for f in faces:
        for k in range(1, len(f) - 1):  # fan from vertex 0: quad -> (0,1,2), (0,2,3)
            tris.append((f[0], f[k], f[k + 1]))
    return np.asarray(tris, dtype=np.int64)


# --- geometry --------------------------------------------------------------

def vertex_normals(verts: np.ndarray, tris: np.ndarray) -> np.ndarray:
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    fn = np.cross(b - a, c - a)  # length = 2 * area -> area weighting
    n = np.zeros_like(verts)
    for k in range(3):
        for d in range(3):
            n[:, d] += np.bincount(tris[:, k], weights=fn[:, d], minlength=len(verts))
    length = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.where(length > 0, length, 1.0)


def quantize(x: np.ndarray) -> tuple[np.ndarray, float]:
    maxabs = float(np.abs(x).max()) if x.size else 0.0
    scale = (maxabs if maxabs > 0 else 1.0) / 32767.0
    q = np.clip(np.round(x / scale), -32767, 32767).astype(np.int16)
    return q, scale


# --- landmark embedding (same method as convert_flame.py) ------------------

def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    u, d, vt = np.linalg.svd(cov)
    sign = np.ones(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[-1] = -1
    r = u @ np.diag(sign) @ vt
    s = (d * sign).sum() / xs.var(0).sum()
    return s, r, mu_d - s * r @ mu_s


def closest_point_on_triangle(p, a, b, c):
    """Ericson, Real-Time Collision Detection 5.1.5. Returns (point, barycentric)."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = ab @ ap, ac @ ap
    if d1 <= 0 and d2 <= 0:
        return a, (1.0, 0.0, 0.0)
    bp = p - b
    d3, d4 = ab @ bp, ac @ bp
    if d3 >= 0 and d4 <= d3:
        return b, (0.0, 1.0, 0.0)
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        v = d1 / (d1 - d3)
        return a + v * ab, (1 - v, v, 0.0)
    cp = p - c
    d5, d6 = ab @ cp, ac @ cp
    if d6 >= 0 and d5 <= d6:
        return c, (0.0, 0.0, 1.0)
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        w = d2 / (d2 - d6)
        return a + w * ac, (1 - w, 0.0, w)
    va = d3 * d6 - d5 * d4
    if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0:
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        return b + w * (c - b), (0.0, 1 - w, w)
    denom = 1.0 / (va + vb + vc)
    v, w = vb * denom, vc * denom
    return a + ab * v + ac * w, (1 - v - w, v, w)


def embed_landmarks(verts: np.ndarray, tris: np.ndarray, skin_mask: np.ndarray,
                    canonical: np.ndarray, max_dist_mm: float) -> dict:
    """verts in metres; tris already reordered. Returns indices into `tris`."""
    skin_idx = np.nonzero(skin_mask)[0]
    skin_tri_ids = np.nonzero(skin_mask[tris].all(1))[0]

    # Both meshes y-up, facing +z; canonical in cm.
    nose_c = canonical[canonical[:, 2].argmax()]
    nose_m = verts[skin_idx[verts[skin_idx, 2].argmax()]]
    s, r, t = 0.01, np.eye(3), nose_m - 0.01 * nose_c

    tree = cKDTree(verts[skin_idx])
    for _ in range(40):
        moved = s * canonical @ r.T + t
        dist, nn = tree.query(moved)
        keep = dist <= np.quantile(dist, 0.9)
        s, r, t = umeyama(canonical[keep], verts[skin_idx[nn[keep]]])
        s = float(np.clip(s, 0.008, 0.012))
        t = (verts[skin_idx[nn[keep]]] - s * canonical[keep] @ r.T).mean(0)

    moved = s * canonical @ r.T + t
    vert_to_tris: dict[int, list[int]] = {}
    for ti in skin_tri_ids:
        for v in tris[ti]:
            vert_to_tris.setdefault(int(v), []).append(int(ti))

    face_ids, barys, dists = [], [], []
    _, near = tree.query(moved, k=12)
    for p, cand in zip(moved, near):
        cands = {f for v in skin_idx[cand] for f in vert_to_tris.get(int(v), [])}
        best = (np.inf, -1, (1.0, 0.0, 0.0))
        for ti in cands:
            a, b, c = verts[tris[ti]]
            q, bary = closest_point_on_triangle(p, a, b, c)
            d = float(np.linalg.norm(p - q))
            if d < best[0]:
                best = (d, ti, bary)
        dists.append(best[0] * 1000)
        face_ids.append(best[1])
        barys.append(best[2])

    dists = np.asarray(dists)
    return {
        "faces": face_ids,
        "bary": np.asarray(barys).round(6).tolist(),
        "valid": (dists <= max_dist_mm).tolist(),
        "residual_mm": dists.round(2).tolist(),
        "alignment": {"scale": s, "rotation": r.tolist(), "translation": t.tolist()},
    }


# --- landmark-only ("lite") model ------------------------------------------

def write_landmark_model(out: Path, meta: dict, arrays: dict, tris: np.ndarray, neutral: np.ndarray) -> int:
    """Writes ict-landmarks.json + ict-landmarks.bin: everything the face driver needs, sampled at
    the embedded MediaPipe landmarks, without the render mesh.

    Sampling matches LandmarkSampler in src/ict.ts exactly: it starts from the same dequantised
    float32 values the browser decodes from ict.bin, interpolates with float32 barycentrics in
    float64, and rounds to float32. All arrays are little-endian float32, landmark-major (x, y, z).
    Returns the total size in bytes.
    """
    lm = meta["landmarks"]
    mp_index = [i for i, ok in enumerate(lm["valid"]) if ok]
    corners = np.asarray([tris[lm["faces"][mp]] for mp in mp_index], dtype=np.int64)  # nL x 3
    bary = np.asarray([lm["bary"][mp] for mp in mp_index], dtype=np.float32).astype(np.float64)
    n_l = len(mp_index)

    def sample(field: np.ndarray) -> np.ndarray:
        """field: (nV, 3) float32 -> (nL, 3) float32, summing corners in LandmarkSampler's order."""
        f = field.astype(np.float64)
        acc = np.zeros((n_l, 3))
        for k in range(3):
            acc = acc + bary[:, k:k + 1] * f[corners[:, k]]
        return acc.astype(np.float32)

    n_verts = len(neutral)
    neutral_f32 = arrays["neutral"].reshape(-1, 3)
    ptr, index = arrays["expr_ptr"], arrays["expr_index"]
    delta = arrays["expr_delta"]
    expr = np.empty((len(meta["expression_names"]), n_l, 3), dtype=np.float32)
    for e, s in enumerate(meta["expr_scales"]):
        a, b = int(ptr[e]), int(ptr[e + 1])
        dense = np.zeros((n_verts, 3), dtype=np.float32)
        dense[index[a:b]] = (delta[a:b].astype(np.float64) * s).astype(np.float32)
        expr[e] = sample(dense)
    ident = np.empty((meta["n_identity"], n_l, 3), dtype=np.float32)
    for k, s in enumerate(meta["id_scales"]):
        ident[k] = sample((arrays["id_delta"][k].astype(np.float64) * s).astype(np.float32))

    lite_arrays = {"neutral": sample(neutral_f32), "expressions": expr, "identities": ident}
    lite: dict = {
        "format": "likeness-landmarks",
        "version": 1,
        "units": "m",
        "source": "ICT-FaceKit (MIT), see LICENSE-ICT-FaceKit",
        "expression_names": meta["expression_names"],
        "n_identity": meta["n_identity"],
        "mediapipe_index": mp_index,
        "arrays": {},
    }
    offset = 0
    with open(out / "ict-landmarks.bin", "wb") as f:
        for name, arr in lite_arrays.items():
            data = np.ascontiguousarray(arr, dtype="<f4").tobytes()
            lite["arrays"][name] = {"dtype": "float32", "offset": offset, "shape": list(arr.shape)}
            f.write(data)
            offset += len(data)
    (out / "ict-landmarks.json").write_text(json.dumps(lite))
    return offset + (out / "ict-landmarks.json").stat().st_size


# --- main ------------------------------------------------------------------

def main() -> None:
    t0 = time.time()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ict_root", type=Path, help="ICT-FaceKit checkout (contains FaceXModel/)")
    ap.add_argument("--out", type=Path, default=ROOT / "public" / "ict")
    ap.add_argument("--n-identity", type=int, default=20)
    ap.add_argument("--canonical", type=Path, default=ROOT / "assets" / "canonical_face_model.obj")
    ap.add_argument("--max-dist-mm", type=float, default=10.0)
    args = ap.parse_args()

    model_dir = args.ict_root / "FaceXModel"
    if not model_dir.is_dir():
        model_dir = args.ict_root
    config = json.loads((model_dir / "vertex_indices.json").read_text())

    # Neutral mesh (cm -> m) and triangles.
    neutral_path = model_dir / "generic_neutral_mesh.obj"
    neutral_cm = read_obj_vertices(neutral_path)
    neutral = neutral_cm * 0.01
    n_verts = len(neutral)
    faces, faces_vt, vt = read_obj_faces_vt(neutral_path)
    tris = triangulate(faces)
    tris_vt = triangulate(faces_vt)  # identical fan split applied to vt indices
    assert PARTS[-1][2] == n_verts, f"expected {PARTS[-1][2]} verts, got {n_verts}"

    # Reorder triangles so each part is contiguous (part of first vertex).
    part_of_vert = np.empty(n_verts, dtype=np.int64)
    for pi, (_, a, b) in enumerate(PARTS):
        part_of_vert[a:b] = pi
    tri_part = part_of_vert[tris[:, 0]]
    order = np.argsort(tri_part, kind="stable")
    tris = tris[order]
    tris_vt = tris_vt[order]

    # Render vertices: unique (position, vt) pairs in first-seen order over the final tris.
    pairs = np.stack([tris.reshape(-1), tris_vt.reshape(-1)], axis=1)
    _, first, inverse = np.unique(pairs, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    rank = np.empty(len(first), dtype=np.int64)
    rank[np.argsort(first, kind="stable")] = np.arange(len(first))
    uv_tris = rank[inverse].reshape(-1, 3)
    seen = np.sort(first)
    uv_vertex = pairs[seen, 0]
    uv = vt[pairs[seen, 1]]
    assert np.array_equal(uv_vertex[uv_tris], tris), "uv_tris does not map back to tris"
    assert uv_tris.reshape(-1)[0] == 0 and np.all(np.diff(np.maximum.accumulate(uv_tris.reshape(-1))) <= 1)
    tri_part = tri_part[order]
    parts = {}
    for pi, (name, a, b) in enumerate(PARTS):
        ts = int(np.searchsorted(tri_part, pi, "left"))
        te = int(np.searchsorted(tri_part, pi, "right"))
        parts[name] = {"verts": [a, b], "tris": [ts, te]}
    n_tris = len(tris)
    normals = vertex_normals(neutral, tris)

    # Expressions: config list (in order), then any extra blendshape OBJs found.
    expr_names = list(config["expressions"])
    known = set(expr_names) | {"generic_neutral_mesh"}
    extras = sorted(p.stem for p in model_dir.glob("*.obj")
                    if p.stem not in known and not p.stem.startswith("identity"))
    expr_names += extras

    ptr = [0]
    idx_list, dq_list, nq_list, expr_scales, expr_nscales = [], [], [], [], []
    check = {}
    for name in expr_names:
        delta = read_obj_vertices(model_dir / f"{name}.obj") * 0.01 - neutral
        nd = vertex_normals(neutral + delta, tris) - normals
        sel = np.nonzero((np.linalg.norm(delta, axis=1) > POS_EPS)
                         | (np.linalg.norm(nd, axis=1) > NORMAL_EPS))[0]
        dq, ds = quantize(delta[sel])
        nq, ns = quantize(nd[sel])
        idx_list.append(sel.astype(np.uint32))
        dq_list.append(dq)
        nq_list.append(nq)
        expr_scales.append(ds)
        expr_nscales.append(ns)
        ptr.append(ptr[-1] + len(sel))
        if name in ("jawOpen", "eyeBlink_L", "mouthSmile_L"):
            check[name] = delta
    n_expr = len(expr_names)

    # Identities: dense.
    id_paths = sorted(model_dir.glob("identity[0-9][0-9][0-9].obj"))
    n_id = min(args.n_identity, len(id_paths))
    id_q = np.empty((n_id, n_verts, 3), dtype=np.int16)
    id_scales = []
    for i in range(n_id):
        delta = read_obj_vertices(id_paths[i]) * 0.01 - neutral
        id_q[i], sc = quantize(delta)
        id_scales.append(sc)

    arrays: dict[str, np.ndarray] = {
        "neutral": neutral.astype(np.float32),
        "normals": normals.astype(np.float32),
        "tris": tris.astype(np.uint32),
        "expr_ptr": np.asarray(ptr, dtype=np.uint32),
        "expr_index": np.concatenate(idx_list).astype(np.uint32),
        "expr_delta": np.concatenate(dq_list).astype(np.int16),
        "expr_normal_delta": np.concatenate(nq_list).astype(np.int16),
        "id_delta": id_q,
        "uv": uv.astype(np.float32),
        "uv_vertex": uv_vertex.astype(np.uint32),
        "uv_tris": uv_tris.astype(np.uint32),
    }

    # Verify quantisation on a few expressions.
    for name, delta in check.items():
        e = expr_names.index(name)
        a, b = ptr[e], ptr[e + 1]
        recon = np.zeros_like(delta)
        recon[arrays["expr_index"][a:b]] = arrays["expr_delta"][a:b].astype(np.float64) * expr_scales[e]
        err = np.abs(recon - delta).max() * 1000
        print(f"verify {name}: {b - a} sparse verts, max |error| {err:.5f} mm")
        assert err < 0.05, f"{name} quantisation error too large"
    id_err = np.abs(id_q[0] * id_scales[0] - (read_obj_vertices(id_paths[0]) * 0.01 - neutral)).max() * 1000
    print(f"verify identity000: max |error| {id_err:.5f} mm")

    # Write binary with 4-byte aligned arrays.
    args.out.mkdir(parents=True, exist_ok=True)
    meta: dict = {
        "n_verts": n_verts,
        "n_tris": n_tris,
        "n_render_verts": int(len(uv)),
        "units": "m",
        "expression_names": expr_names,
        "n_identity": n_id,
        "parts": parts,
        "arrays": {},
        "expr_scales": expr_scales,
        "expr_normal_scales": expr_nscales,
        "id_scales": id_scales,
    }
    offset = 0
    with open(args.out / "ict.bin", "wb") as f:
        for name, a in arrays.items():
            pad = (-offset) % 4
            f.write(b"\0" * pad)
            offset += pad
            data = np.ascontiguousarray(a).astype(a.dtype.newbyteorder("<")).tobytes()
            meta["arrays"][name] = {"dtype": str(a.dtype), "offset": offset, "shape": list(a.shape)}
            f.write(data)
            offset += len(data)

    canonical = np.asarray([l.split()[1:4] for l in args.canonical.read_text().splitlines()
                            if l.startswith("v ")], dtype=np.float64)
    skin = np.zeros(n_verts, dtype=bool)
    a, b = parts[SKIN_PART]["verts"]
    skin[a:b] = True
    meta["landmarks"] = embed_landmarks(neutral, tris, skin, canonical, args.max_dist_mm)
    (args.out / "ict.json").write_text(json.dumps(meta))
    lite_bytes = write_landmark_model(args.out, meta, arrays, tris, neutral)

    face_v = neutral[a:b]
    nose = face_v[face_v[:, 2].argmax()]
    res = np.asarray(meta["landmarks"]["residual_mm"])
    print(f"wrote {args.out / 'ict.bin'} ({offset / 1e6:.2f} MB), "
          f"ict.json ({(args.out / 'ict.json').stat().st_size / 1e3:.0f} kB)")
    print(f"wrote {args.out / 'ict-landmarks.json'} + .bin ({lite_bytes / 1e3:.0f} kB, landmark-only tracking model)")
    print(f"V={n_verts} T={n_tris} E={n_expr} I={n_id} (of {len(id_paths)}) sparse N={ptr[-1]}")
    if extras:
        print(f"extra expressions beyond vertex_indices.json: {extras}")
    for name, p in parts.items():
        print(f"  {name:22s} verts {p['verts']}  tris {p['tris']}")
    print(f"render verts V2={len(uv)} (uv {uv.nbytes + uv_vertex.nbytes // 2 * 2 + uv_tris.size * 4} bytes)")
    print(f"nose tip (m): {np.round(nose, 4).tolist()} (vertex {a + int(face_v[:, 2].argmax())})")
    print(f"landmark fit: median {np.median(res):.2f} mm, 95th pct {np.percentile(res, 95):.2f} mm, "
          f"max {res.max():.2f} mm, {int(sum(meta['landmarks']['valid']))}/{len(res)} valid, "
          f"scale {meta['landmarks']['alignment']['scale']:.5f}")
    print(f"runtime {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
