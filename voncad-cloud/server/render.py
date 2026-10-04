"""Headless PNG renderer (no GPU): painter's algorithm in Pillow + a depth image for edge
visibility. Good enough for agents to *see* what they built, with optional id labels."""
from __future__ import annotations

import io
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

VIEWS = {
    "iso": (1.0, -1.0, 0.8), "iso2": (-1.0, -1.0, 0.8), "iso_back": (-1.0, 1.0, 0.8),
    "iso_below": (1.0, -1.0, -0.8),
    "front": (0, -1, 0), "back": (0, 1, 0), "right": (1, 0, 0), "left": (-1, 0, 0),
    "top": (0, 0, 1), "bottom": (0, 0, -1),
}
HL = np.array([255, 120, 40], float)


def _hex(c):
    c = (c or "#d9d7d2").lstrip("#")
    return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], float)


def _camera(view, bbox):
    if isinstance(view, (list, tuple)):
        d = np.array(view, float)
    else:
        d = np.array(VIEWS.get(view, VIEWS["iso"]), float)
    d /= np.linalg.norm(d)
    up = np.array([0, 0, 1.0]) if abs(d[2]) < 0.99 else np.array([0, 1.0, 0])
    right = np.cross(up, d)
    right /= np.linalg.norm(right)
    up = np.cross(d, right)
    lo, hi = np.array(bbox["min"]), np.array(bbox["max"])
    return d, right, up, (lo + hi) / 2


def _font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    try:
        return ImageFont.load_default(size)
    except TypeError:
        return ImageFont.load_default()


def render(vdir: str, view="iso", w=800, h=600, highlight=(), labels=False, edges=True,
           hidden=None, bg="#ffffff", frame=None, as_image=False):
    """frame: another version dir whose extent fixes the camera (stable framing for animations)."""
    scene_meta = json.load(open(os.path.join(vdir, "topology.json")))
    data = np.load(os.path.join(vdir, "mesh.npz"))
    parts = scene_meta["parts"]
    colors = json.load(open(os.path.join(vdir, "parts.json")))
    hidden = set(hidden or ())
    highlight = set(highlight or ())
    frame_meta = json.load(open(os.path.join(frame, "topology.json"))) if frame else scene_meta
    d, right, up, center = _camera(view, frame_meta["bbox"])
    ss = 2
    W, H = w * ss, h * ss

    # project everything to find the scale
    fdata = np.load(os.path.join(frame, "mesh.npz")) if frame else data
    allp = [fdata[f"{p['id']}_pos"] for p in frame_meta["parts"] if p["id"] not in hidden and len(fdata[f"{p['id']}_pos"])]
    if not allp:
        img = Image.new("RGB", (w, h), bg)
        if as_image:
            return img
        b = io.BytesIO(); img.save(b, "PNG"); return b.getvalue()
    pts = np.concatenate(allp) - center
    sx, sy = pts @ right, pts @ up
    span = max(sx.max() - sx.min(), sy.max() - sy.min() * 1.0, 1e-6)
    scale = 0.84 * min(W / max(sx.max() - sx.min(), 1e-6), H / max(sy.max() - sy.min(), 1e-6))
    cx, cy = (sx.max() + sx.min()) / 2, (sy.max() + sy.min()) / 2

    def proj(p):
        q = p - center
        return np.stack([(q @ right - cx) * scale + W / 2, H / 2 - (q @ up - cy) * scale, q @ d], -1)

    img = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(img)
    depth = Image.new("F", (W, H), -1e9)
    ddraw = ImageDraw.Draw(depth)

    light1 = np.array([0.45, -0.35, 0.82]); light1 /= np.linalg.norm(light1)
    light2 = -d * 0.6 + np.array([-0.5, 0.3, 0.2]); light2 /= np.linalg.norm(light2)

    tris_all = []
    for pi, p in enumerate(parts):
        if p["id"] in hidden:
            continue
        pos, nrm, idx = data[f"{p['id']}_pos"], data[f"{p['id']}_nrm"], data[f"{p['id']}_idx"].reshape(-1, 3)
        if not len(idx):
            continue
        base = _hex(colors[pi].get("color") if pi < len(colors) else None)
        tri_col = np.tile(base, (len(idx), 1))
        part_hl = p["id"] in highlight
        for f in p["faces"]:
            if part_hl or f["id"] in highlight:
                tri_col[f["start"]:f["start"] + f["count"]] = HL
        P = proj(pos)
        tp = P[idx]                                        # (n,3,3)
        n = nrm[idx].mean(1)
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        facing = n @ d
        n = np.where(facing[:, None] < 0, -n, n)           # light both sides
        shade = 0.42 + 0.48 * np.clip(n @ light1, 0, 1) + 0.18 * np.clip(n @ light2, 0, 1)
        spec = np.clip(n @ ((light1 + d) / np.linalg.norm(light1 + d)), 0, 1) ** 40 * 0.25
        col = np.clip(tri_col * shade[:, None] + 255 * spec[:, None], 0, 255)
        z = tp[:, :, 2].mean(1)
        tris_all.append((z, tp, col))

    z = np.concatenate([t[0] for t in tris_all])
    tp = np.concatenate([t[1] for t in tris_all])
    col = np.concatenate([t[2] for t in tris_all]).astype(int)
    order = np.argsort(z)
    for i in order:
        poly = [(float(tp[i, k, 0]), float(tp[i, k, 1])) for k in range(3)]
        c = tuple(col[i])
        draw.polygon(poly, fill=c, outline=c)
        zz = float(tp[i, :, 2].mean())
        ddraw.polygon(poly, fill=zz, outline=zz)

    dep = np.asarray(depth)
    if edges:
        tol = 0.012 * span
        for p in parts:
            if p["id"] in hidden:
                continue
            seg = data[f"{p['id']}_edges"]
            if not len(seg):
                continue
            S = proj(seg.astype(float)).reshape(-1, 2, 3)
            for a, b in S:
                L = max(int(math.hypot(b[0] - a[0], b[1] - a[1]) / 3), 1)
                ts = np.linspace(0, 1, L + 1)
                q = a[None] + (b - a)[None] * ts[:, None]
                xi = np.clip(q[:, 0].astype(int), 0, W - 1)
                yi = np.clip(q[:, 1].astype(int), 0, H - 1)
                vis = q[:, 2] >= dep[yi, xi] - tol
                for k in range(L):
                    if vis[k] and vis[k + 1]:
                        draw.line([(q[k, 0], q[k, 1]), (q[k + 1, 0], q[k + 1, 1])], fill=(28, 28, 28), width=ss + 1)
        # highlighted edges on top
        for p in parts:
            for e in p["edges"]:
                if e["id"] in highlight and "start" in e:
                    pass
    img = img.resize((w, h), Image.LANCZOS)

    if labels or highlight:
        dr = ImageDraw.Draw(img)
        font = _font(11)
        for p in parts:
            if p["id"] in hidden:
                continue
            for f in p["faces"]:
                if "center" not in f or (not labels and f["id"] not in highlight):
                    continue
                if labels and f["area"] < 0.002 * (span ** 2) and f["id"] not in highlight:
                    continue
                q = proj(np.array(f["center"], float))
                X, Y = int(q[0]), int(q[1])
                if not (0 <= X < W and 0 <= Y < H) or q[2] < dep[Y, X] - 0.02 * span:
                    continue
                t = f["id"].split("/")[1] if len(parts) == 1 else f["id"]
                x, y = q[0] / ss, q[1] / ss
                bb = dr.textbbox((x, y), t, font=font, anchor="mm")
                dr.rectangle((bb[0] - 3, bb[1] - 2, bb[2] + 3, bb[3] + 2), fill=(255, 255, 255), outline=(30, 30, 30))
                dr.text((x, y), t, fill=(20, 20, 20), font=font, anchor="mm")
    _triad(img, right, up)
    if as_image:
        return img
    b = io.BytesIO()
    img.save(b, "PNG", optimize=True)
    return b.getvalue()


def _triad(img, right, up):
    dr = ImageDraw.Draw(img)
    o = np.array([34.0, img.height - 34.0])
    font = _font(10)
    for axis, col, name in ((np.array([1, 0, 0.]), (200, 60, 50), "X"), (np.array([0, 1, 0.]), (60, 150, 70), "Y"),
                            (np.array([0, 0, 1.]), (50, 90, 200), "Z")):
        v = np.array([axis @ right, -(axis @ up)]) * 20
        dr.line([tuple(o), tuple(o + v)], fill=col, width=2)
        dr.text(tuple(o + v * 1.35), name, fill=col, font=font, anchor="mm")


def render_grid(vdir: str, size=420, labels=False) -> bytes:
    """Four views in one image: iso, front, top, right. One call = full understanding."""
    tiles = [(v, Image.open(io.BytesIO(render(vdir, v, size, size, labels=labels)))) for v in ("iso", "front", "top", "right")]
    out = Image.new("RGB", (size * 2, size * 2), "#ffffff")
    dr = ImageDraw.Draw(out)
    font = _font(12)
    for i, (name, t) in enumerate(tiles):
        x, y = (i % 2) * size, (i // 2) * size
        out.paste(t, (x, y))
        dr.text((x + 10, y + 8), name.upper(), fill=(90, 90, 90), font=font)
    dr.line([(size, 0), (size, 2 * size)], fill=(220, 220, 220))
    dr.line([(0, size), (2 * size, size)], fill=(220, 220, 220))
    b = io.BytesIO()
    out.save(b, "PNG", optimize=True)
    return b.getvalue()
