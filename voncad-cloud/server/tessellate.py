"""Shape -> scene (what the viewer draws) and topology (what an agent reads).

Scene format v1 (JSON):

    {
      "format": "voncad-scene", "version": 1, "units": "mm",
      "bbox": {"min": [x,y,z], "max": [x,y,z]},
      "parts": [{
        "id": "p0", "name": "bracket", "color": "#d8d6d0",
        "positions": <b64 float32 xyz>, "normals": <b64 float32 xyz>,
        "indices": <b64 uint32>,
        "faces": [{"id": "p0/f3", "type": "plane", "start": <first triangle>,
                   "count": <triangles>, "area": 12.5, "center": [..], "normal": [..]}],
        "edges": [{"id": "p0/e7", "type": "line", "length": 10.0,
                   "points": <b64 float32 xyz polyline>}]
      }]
    }

Triangles of a face are contiguous, so `start`/`count` map a picked triangle to its face.
Face / edge numbers follow build123d's `shape.faces()` / `shape.edges()` order, so a script
can say `part.faces()[3]` for the face the viewer and API call `p0/f3`.
"""
from __future__ import annotations

import base64
import math

import numpy as np
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopLoc import TopLoc_Location

PALETTE = ["#d9d7d2", "#4a4a4a", "#b9c3c9", "#cdbfa8", "#9aa79a", "#c9b2b2", "#a7a2b8", "#8f8f8f"]


def b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


def _r(v, n=4):
    return [round(float(x), n) for x in v]


def face_kind(face) -> str:
    try:
        return face.geom_type.name.lower()
    except Exception:
        return "other"


def edge_kind(edge) -> str:
    try:
        return edge.geom_type.name.lower()
    except Exception:
        return "other"


def describe_face(face, fid: str) -> dict:
    d = {"id": fid, "type": face_kind(face), "area": round(face.area, 4)}
    try:
        c = face.center()
        d["center"] = _r(c)
        if d["type"] == "plane":
            d["normal"] = _r(face.normal_at(c))
        elif d["type"] in ("cylinder", "cone", "sphere", "torus"):
            try:
                d["radius"] = round(face.radius, 4)
            except Exception:
                pass
            try:
                d["axis"] = _r(face.axis_of_rotation.direction)
            except Exception:
                pass
    except Exception:
        pass
    return d


def describe_edge(edge, eid: str) -> dict:
    d = {"id": eid, "type": edge_kind(edge), "length": round(edge.length, 4)}
    try:
        d["start"] = _r(edge.position_at(0))
        d["end"] = _r(edge.position_at(1))
        if d["type"] == "circle":
            d["radius"] = round(edge.radius, 4)
            d["center"] = _r(edge.arc_center)
    except Exception:
        pass
    return d


def _mesh_face(face, reversed_):
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
    if tri is None:
        return None
    trsf = loc.Transformation()
    n = tri.NbNodes()
    pts = np.empty((n, 3), np.float64)
    for i in range(1, n + 1):
        p = tri.Node(i).Transformed(trsf)
        pts[i - 1] = (p.X(), p.Y(), p.Z())
    m = tri.NbTriangles()
    idx = np.empty((m, 3), np.int64)
    for i in range(1, m + 1):
        a, b, c = tri.Triangle(i).Get()
        idx[i - 1] = (a - 1, c - 1, b - 1) if reversed_ else (a - 1, b - 1, c - 1)
    # Smooth normals from the surface where possible, else from triangles
    nrm = None
    try:
        if not tri.HasNormals():
            from OCP.BRepLib import BRepLib_ToolTriangulatedShape
            BRepLib_ToolTriangulatedShape.ComputeNormals_s(face.wrapped, tri)
        nrm = np.empty((n, 3), np.float64)
        rot = trsf
        for i in range(1, n + 1):
            v = tri.Normal(i).Transformed(rot)
            nrm[i - 1] = (v.X(), v.Y(), v.Z())
        if reversed_:
            nrm = -nrm
    except Exception:
        nrm = None
    if nrm is None:
        nrm = np.zeros_like(pts)
        fn = np.cross(pts[idx[:, 1]] - pts[idx[:, 0]], pts[idx[:, 2]] - pts[idx[:, 0]])
        for k in range(3):
            np.add.at(nrm, idx[:, k], fn)
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = nrm / np.where(ln == 0, 1, ln)
    return pts, nrm, idx


def _edge_polyline(edge, deflection):
    try:
        curve = BRepAdaptor_Curve(edge.wrapped)
        disc = GCPnts_TangentialDeflection(curve, 0.2, deflection)
        pts = []
        for i in range(1, disc.NbPoints() + 1):
            p = disc.Value(i)
            pts.append((p.X(), p.Y(), p.Z()))
        if len(pts) >= 2:
            return np.array(pts, np.float64)
    except Exception:
        pass
    try:
        return np.array([tuple(edge.position_at(t)) for t in np.linspace(0, 1, 24)])
    except Exception:
        return None


QUALITY = {"draft": (600.0, 0.5), "normal": (2000.0, 0.25), "fine": (6000.0, 0.12)}
_quality = "normal"


def set_quality(q: str):
    global _quality
    _quality = q if q in QUALITY else "normal"


def tolerance_for(shape) -> tuple[float, float]:
    bb = shape.bounding_box(optimal=False)
    diag = max(bb.diagonal, 1e-6)
    div, ang = QUALITY[_quality]
    return max(diag / div, 0.002), ang


def mesh_shape(shape, pid: str, name: str, color: str, with_mesh=True) -> dict:
    """Mesh one part. Returns a scene part plus numpy buffers (for the renderer)."""
    lin, ang = tolerance_for(shape)
    if with_mesh:
        BRepMesh_IncrementalMesh(shape.wrapped, lin, False, ang, True)
    faces = shape.faces()
    edges = shape.edges()
    P, N, I, face_desc = [], [], [], []
    vbase = 0
    tbase = 0
    for k, f in enumerate(faces):
        fid = f"{pid}/f{k}"
        d = describe_face(f, fid)
        res = _mesh_face(f, f.wrapped.Orientation() == TopAbs_REVERSED) if with_mesh else None
        if res is not None:
            pts, nrm, idx = res
            P.append(pts); N.append(nrm); I.append(idx + vbase)
            d["start"], d["count"] = tbase, len(idx)
            vbase += len(pts); tbase += len(idx)
        else:
            d["start"], d["count"] = tbase, 0
        face_desc.append(d)
    pos = np.concatenate(P) if P else np.zeros((0, 3))
    nor = np.concatenate(N) if N else np.zeros((0, 3))
    ind = np.concatenate(I) if I else np.zeros((0, 3), np.int64)
    edge_desc, polylines = [], []
    for k, e in enumerate(edges):
        d = describe_edge(e, f"{pid}/e{k}")
        pl = _edge_polyline(e, lin) if with_mesh else None
        polylines.append(pl)
        edge_desc.append(d)
    part = {"id": pid, "name": name, "color": color, "faces": face_desc, "edges": edge_desc}
    bufs = {"positions": pos, "normals": nor, "indices": ind, "polylines": polylines}
    return part, bufs


def to_scene_part(part: dict, bufs: dict) -> dict:
    out = dict(part)
    out["positions"] = b64(bufs["positions"].astype(np.float32))
    out["normals"] = b64(bufs["normals"].astype(np.float32))
    out["indices"] = b64(bufs["indices"].astype(np.uint32).ravel())
    edges = []
    for d, pl in zip(part["edges"], bufs["polylines"]):
        d = dict(d)
        if pl is not None:
            d["points"] = b64(pl.astype(np.float32))
        edges.append(d)
    out["edges"] = edges
    return out


def color_hex(c) -> str | None:
    try:
        r, g, b = list(c)[:3]
        return "#%02x%02x%02x" % tuple(int(max(0, min(1, v)) * 255) for v in (r, g, b))
    except Exception:
        return None


def flatten_parts(obj, name="part"):
    """Turn whatever a script produced into [(name, shape, color|None)] leaf parts."""
    from build123d import Compound, Shape
    out = []

    def walk(o, nm):
        if o is None:
            return
        if hasattr(o, "part") and not isinstance(o, Shape):   # BuildPart / BuildSketch / BuildLine
            for attr in ("part", "sketch", "line"):
                v = getattr(o, attr, None)
                if v is not None:
                    walk(v, nm)
                    return
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, str(k))
            return
        if isinstance(o, (list, tuple)):
            for i, v in enumerate(o):
                walk(v, getattr(v, "label", "") or f"{nm}_{i}")
            return
        if isinstance(o, Compound) and list(getattr(o, "children", ()) or ()):
            for i, ch in enumerate(o.children):
                walk(ch, getattr(ch, "label", "") or f"{nm}_{i}")
            return
        if isinstance(o, Shape):
            col = color_hex(o.color) if getattr(o, "color", None) is not None else None
            out.append((getattr(o, "label", "") or nm, o, col))

    walk(obj, name)
    return out


def bbox_of(shapes):
    lo = np.array([math.inf] * 3)
    hi = -lo
    for s in shapes:
        bb = s.bounding_box(optimal=False)
        lo = np.minimum(lo, [bb.min.X, bb.min.Y, bb.min.Z])
        hi = np.maximum(hi, [bb.max.X, bb.max.Y, bb.max.Z])
    if not np.isfinite(lo).all():
        lo = hi = np.zeros(3)
    return {"min": _r(lo), "max": _r(hi)}


def build_scene(parts):
    """parts: [(name, shape, color)] -> (scene dict, buffers list, topology dict)"""
    scene_parts, all_bufs, topo_parts = [], [], []
    for i, (name, shape, color) in enumerate(parts):
        pid = f"p{i}"
        part, bufs = mesh_shape(shape, pid, name, color or PALETTE[i % len(PALETTE)])
        scene_parts.append(to_scene_part(part, bufs))
        all_bufs.append(bufs)
        topo_parts.append(part)
    bbox = bbox_of([p[1] for p in parts])
    scene = {"format": "voncad-scene", "version": 1, "units": "mm", "bbox": bbox, "parts": scene_parts}
    topo = {"units": "mm", "bbox": bbox, "parts": topo_parts}
    return scene, all_bufs, topo
