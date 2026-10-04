"""Operations on a built version: exports, measure, section, mass, DFM checks, diff.
All functions take version directories and are meant to run inside kernel.isolated()."""
from __future__ import annotations

import json
import math
import os

from kernel import load_parts

EXPORT_TYPES = {
    "step": ("model.step", "application/step"),
    "stl": ("model.stl", "model/stl"),
    "glb": ("model.glb", "model/gltf-binary"),
    "3mf": ("model.3mf", "model/3mf"),
    "brep": ("model.brep", "application/octet-stream"),
    "svg": ("drawing.svg", "image/svg+xml"),
    "dxf": ("drawing.dxf", "image/vnd.dxf"),
    "obj": ("model.obj", "text/plain"),
}


def _compound(parts):
    import build123d as bd
    shapes = []
    for name, s, color in parts:
        s.label = name
        if color:
            try:
                s.color = bd.Color(color)
            except Exception:
                pass
        shapes.append(s)
    return shapes[0] if len(shapes) == 1 else bd.Compound(label="model", children=shapes)


def export(vdir: str, fmt: str) -> str:
    """Write the export file (cached) and return its path."""
    import build123d as bd
    fname, _mime = EXPORT_TYPES[fmt]
    path = os.path.join(vdir, fname)
    if os.path.exists(path):
        return path
    parts = load_parts(vdir)
    comp = _compound(parts)
    tmp = path + ".tmp"
    if fmt == "step":
        bd.export_step(comp, tmp)
    elif fmt == "stl":
        bd.export_stl(comp, tmp, tolerance=0.01, angular_tolerance=0.2)
    elif fmt == "glb":
        bd.export_gltf(comp, tmp, binary=True, linear_deflection=0.01, angular_deflection=0.2)
    elif fmt == "brep":
        bd.export_brep(comp, tmp)
    elif fmt == "3mf":
        m = bd.Mesher()
        for _n, s, _c in parts:
            m.add_shape(s, linear_deflection=0.01, angular_deflection=0.2)
        m.write(tmp + ".3mf")
        os.replace(tmp + ".3mf", tmp)
    elif fmt == "obj":
        _write_obj(vdir, tmp)
    elif fmt in ("svg", "dxf"):
        _drawing(comp, tmp, fmt)
    os.replace(tmp, path)
    return path


def _write_obj(vdir, path):
    import numpy as np
    data = np.load(os.path.join(vdir, "mesh.npz"))
    topo = json.load(open(os.path.join(vdir, "topology.json")))
    with open(path, "w") as f:
        f.write("# Voncad Cloud OBJ export\n")
        base = 1
        for p in topo["parts"]:
            pos, nrm, idx = data[f"{p['id']}_pos"], data[f"{p['id']}_nrm"], data[f"{p['id']}_idx"].reshape(-1, 3)
            f.write(f"o {p['name']}\n")
            for v in pos:
                f.write("v %.5f %.5f %.5f\n" % tuple(v))
            for v in nrm:
                f.write("vn %.4f %.4f %.4f\n" % tuple(v))
            for t in idx + base:
                f.write("f %d//%d %d//%d %d//%d\n" % (t[0], t[0], t[1], t[1], t[2], t[2]))
            base += len(pos)


def _drawing(shape, path, fmt):
    """Three-view orthographic drawing (front, top, right) + iso, with hidden lines dashed."""
    import build123d as bd
    bb = shape.bounding_box()
    size = max(bb.size.X, bb.size.Y, bb.size.Z, 1e-3)
    gap = size * 0.35
    views = {
        "front": ((0, -1, 0), (0, 0, 1), (0, 0)),
        "top": ((0, 0, 1), (0, 1, 0), (0, size + gap)),
        "right": ((1, 0, 0), (0, 0, 1), (size + gap, 0)),
        "iso": ((1, -1, 0.8), (0, 0, 1), (size + gap, size + gap)),
    }
    c = bb.center()
    if fmt == "svg":
        exp = bd.ExportSVG(unit=bd.Unit.MM, line_weight=0.35, margin=8)
        exp.add_layer("visible", line_weight=0.35)
        exp.add_layer("hidden", line_color=(140, 140, 140), line_type=bd.LineType.ISO_DASH, line_weight=0.2)
    else:
        exp = bd.ExportDXF(unit=bd.Unit.MM)
        exp.add_layer("visible")
        exp.add_layer("hidden", line_type=bd.LineType.ISO_DASH)
    for name, (d, up, (ox, oy)) in views.items():
        dv = bd.Vector(*d).normalized()
        origin = c + dv * size * 4
        try:
            vis, hid = shape.project_to_viewport(tuple(origin), viewport_up=up, look_at=tuple(c))
        except Exception:
            continue
        shift = bd.Location((ox, oy, 0))
        exp.add_shape([e.moved(shift) for e in vis], layer="visible")
        if name != "iso":
            exp.add_shape([e.moved(shift) for e in hid], layer="hidden")
    exp.write(path)


def _entity(parts, ref):
    """'p0/f3' -> Face, 'p0/e7' -> Edge, 'p0/v2' -> Vertex, 'p0' -> part shape."""
    try:
        pid, _, sub = ref.partition("/")
        s = parts[int(pid.lstrip("p"))][1]
        if not sub:
            return s
        kind, k = sub[0], int(sub[1:])
        return {"f": s.faces, "e": s.edges, "v": s.vertices}[kind]()[k]
    except Exception:
        raise ValueError(f"unknown reference '{ref}' (expected like p0/f3, p0/e7, p0/v1 or p0)")


def measure(vdir: str, a: str, b: str | None = None) -> dict:
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    parts = load_parts(vdir)
    ea = _entity(parts, a)
    out = {"a": _props(ea, a)}
    if b:
        eb = _entity(parts, b)
        out["b"] = _props(eb, b)
        dss = BRepExtrema_DistShapeShape(ea.wrapped, eb.wrapped)
        dss.Perform()
        if dss.IsDone():
            out["distance"] = round(dss.Value(), 6)
            p1, p2 = dss.PointOnShape1(1), dss.PointOnShape2(1)
            out["closest_points"] = [[round(p1.X(), 5), round(p1.Y(), 5), round(p1.Z(), 5)],
                                     [round(p2.X(), 5), round(p2.Y(), 5), round(p2.Z(), 5)]]
        try:
            out["center_distance"] = round((ea.center() - eb.center()).length, 6)
        except Exception:
            pass
        da, db = _direction(ea), _direction(eb)
        if da is not None and db is not None:
            cosang = max(-1.0, min(1.0, da.dot(db)))
            out["angle_deg"] = round(math.degrees(math.acos(abs(cosang))), 4)
            out["parallel"] = abs(abs(cosang) - 1) < 1e-6
            out["perpendicular"] = abs(cosang) < 1e-6
    return out


def _direction(e):
    import build123d as bd
    try:
        if isinstance(e, bd.Face) and e.geom_type == bd.GeomType.PLANE:
            return e.normal_at(e.center())
        if isinstance(e, bd.Face) and e.geom_type in (bd.GeomType.CYLINDER, bd.GeomType.CONE):
            return e.axis_of_rotation.direction
        if isinstance(e, bd.Edge) and e.geom_type == bd.GeomType.LINE:
            return (e.position_at(1) - e.position_at(0)).normalized()
        if isinstance(e, bd.Edge) and e.geom_type == bd.GeomType.CIRCLE:
            return e.normal()
    except Exception:
        return None
    return None


def _props(e, ref):
    import build123d as bd
    from tessellate import describe_edge, describe_face
    if isinstance(e, bd.Face):
        return describe_face(e, ref)
    if isinstance(e, bd.Edge):
        return describe_edge(e, ref)
    if isinstance(e, bd.Vertex):
        return {"id": ref, "type": "vertex", "position": [round(x, 5) for x in tuple(e)]}
    bb = e.bounding_box()
    return {"id": ref, "type": "part", "volume": round(e.volume, 4),
            "bbox": [list(map(lambda v: round(v, 4), tuple(bb.min))), list(map(lambda v: round(v, 4), tuple(bb.max)))]}


def section(vdir: str, origin, normal) -> dict:
    """Cut every part with a plane; return the cut faces' area and a hatched SVG."""
    import build123d as bd
    parts = load_parts(vdir)
    plane = bd.Plane(origin=tuple(origin), z_dir=tuple(normal))
    big = 1e5
    half = bd.Box(big, big, big, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MAX)).moved(bd.Location(plane))
    faces = []
    for _n, s, _c in parts:
        try:
            kept = s & half
        except Exception:
            continue
        for f in (kept.faces() if kept else []):
            try:
                c = f.center()
                if abs((c - plane.origin).dot(plane.z_dir)) < 1e-4 and \
                        abs(f.normal_at(c).dot(plane.z_dir)) > 0.999:
                    faces.append(f)
            except Exception:
                pass
    area = sum(f.area for f in faces)
    return {"area": round(area, 4), "regions": len(faces), "svg": _faces_svg(faces, plane)}


def _faces_svg(faces, plane):
    import build123d as bd
    if not faces:
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'
    loc = [plane.to_local_coords(f) for f in faces]
    bb = bd.Compound(children=loc).bounding_box()
    pad = max(bb.size.X, bb.size.Y) * 0.06 + 1
    x0, y0, w, h = bb.min.X - pad, bb.min.Y - pad, bb.size.X + 2 * pad, bb.size.Y + 2 * pad
    paths = []
    for f in loc:
        d = ""
        for wire in [f.outer_wire()] + list(f.inner_wires()):
            pts = []
            for e in wire.edges():
                n = 2 if e.geom_type == bd.GeomType.LINE else 24
                pts += [e.position_at(t / n) for t in range(n)]
            if pts:
                d += "M" + " L".join(f"{p.X:.3f},{-p.Y:.3f}" for p in pts) + " Z "
        paths.append(d)
    body = "".join(f'<path d="{d}" fill="url(#hatch)" stroke="#121212" stroke-width="{w / 400:.3f}" fill-rule="evenodd"/>' for d in paths)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.3f} {-(y0 + h):.3f} {w:.3f} {h:.3f}">'
            f'<defs><pattern id="hatch" width="{w / 60:.3f}" height="{w / 60:.3f}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
            f'<line x1="0" y1="0" x2="0" y2="{w / 60:.3f}" stroke="#121212" stroke-width="{w / 600:.3f}"/></pattern></defs>{body}</svg>')


def mass(vdir: str, density: float = 7.85) -> dict:
    """density in g/cm³"""
    import build123d as bd
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    parts = load_parts(vdir)
    out, total_m = [], 0.0
    acc = [0.0, 0.0, 0.0]
    for i, (name, s, _c) in enumerate(parts):
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(s.wrapped, props)
        v = props.Mass()
        m = v / 1000.0 * density            # mm³ -> cm³ -> g
        c = props.CentreOfMass()
        I = props.MatrixOfInertia()
        k = density / 1000.0 / 1000.0        # g/mm³ -> inertia in g·mm²... keep kg·mm²
        inertia = [[round(I.Value(r, q) * density / 1e6, 6) for q in (1, 2, 3)] for r in (1, 2, 3)]
        out.append({"id": f"p{i}", "name": name, "volume_mm3": round(v, 4), "mass_g": round(m, 4),
                    "center_of_mass": [round(c.X(), 4), round(c.Y(), 4), round(c.Z(), 4)],
                    "inertia_kg_mm2_about_com": inertia, "surface_area_mm2": round(s.area, 4)})
        total_m += m
        for j, x in enumerate((c.X(), c.Y(), c.Z())):
            acc[j] += x * m
    com = [round(x / total_m, 4) for x in acc] if total_m else None
    return {"density_g_cm3": density, "parts": out, "mass_g": round(total_m, 4), "center_of_mass": com}


BUILD_VOLUMES = {"fdm": (256, 256, 256), "cnc": (600, 400, 300), "sheet": (1500, 3000, 50)}


def check(vdir: str, process: str = "fdm") -> dict:
    import build123d as bd
    import numpy as np
    parts = load_parts(vdir)
    issues, metrics = [], {}
    for i, (name, s, _c) in enumerate(parts):
        pid = f"p{i}"
        bb = s.bounding_box()
        size = sorted([bb.size.X, bb.size.Y, bb.size.Z])
        vol = sorted(BUILD_VOLUMES.get(process, BUILD_VOLUMES["fdm"]))
        if any(a > b for a, b in zip(size, vol)):
            issues.append({"severity": "error", "part": pid, "code": "too_large",
                           "message": f"{name} ({' × '.join(f'{x:.0f}' for x in size)} mm) does not fit a typical {process} envelope {' × '.join(map(str, vol))} mm."})
        if not (s.is_valid() if callable(s.is_valid) else s.is_valid):
            issues.append({"severity": "error", "part": pid, "code": "invalid", "message": f"{name} is not a valid solid."})
        if len(s.solids()) > 1:
            issues.append({"severity": "warning", "part": pid, "code": "multiple_solids",
                           "message": f"{name} has {len(s.solids())} disconnected solids."})
        short = [k for k, e in enumerate(s.edges()) if e.length < 0.2]
        if short:
            issues.append({"severity": "warning", "part": pid, "code": "tiny_edges",
                           "message": f"{len(short)} edges shorter than 0.2 mm (may not be manufacturable).",
                           "refs": [f"{pid}/e{k}" for k in short[:20]]})
        if process == "fdm":
            over, area_over, total = [], 0.0, 0.0
            zmin = bb.min.Z
            for k, f in enumerate(s.faces()):
                try:
                    a = f.area
                    total += a
                    n = f.normal_at(f.center())
                    if n.Z < -0.7072 and f.center().Z > zmin + 0.3:   # > 45° overhang, not on the bed
                        over.append(f"{pid}/f{k}")
                        area_over += a
                except Exception:
                    pass
            metrics[pid] = {"overhang_area_mm2": round(area_over, 2), "overhang_fraction": round(area_over / total, 4) if total else 0}
            if over:
                issues.append({"severity": "info", "part": pid, "code": "overhangs",
                               "message": f"{len(over)} faces overhang more than 45° and need support in this orientation.",
                               "refs": over[:40]})
        if process == "cnc":
            for k, e in enumerate(s.edges()):
                pass
            sharp_inner = []
            for k, f in enumerate(s.faces()):
                if f.geom_type == bd.GeomType.CYLINDER:
                    try:
                        if f.radius < 1.0:
                            sharp_inner.append(f"{pid}/f{k}")
                    except Exception:
                        pass
            if sharp_inner:
                issues.append({"severity": "warning", "part": pid, "code": "small_radius",
                               "message": f"{len(sharp_inner)} cylindrical faces under 1 mm radius need small tools.",
                               "refs": sharp_inner[:40]})
        # thin wall estimate: ray-cast inward from face centres
        try:
            metrics.setdefault(pid, {})["min_wall_mm_estimate"] = _min_wall(s)
            mw = metrics[pid]["min_wall_mm_estimate"]
            lim = {"fdm": 0.8, "cnc": 0.5, "sheet": 0.3}.get(process, 0.8)
            if mw is not None and mw < lim:
                issues.append({"severity": "warning", "part": pid, "code": "thin_wall",
                               "message": f"Estimated minimum wall {mw:.2f} mm is under {lim} mm for {process}."})
        except Exception:
            pass
    return {"process": process, "ok": not any(i["severity"] == "error" for i in issues),
            "issues": issues, "metrics": metrics}


def _min_wall(s):
    """Shoot a ray inward from each planar/cylindrical face centre; nearest exit = wall thickness."""
    from OCP.BRepIntCurveSurface import BRepIntCurveSurface_Inter
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt
    best = None
    faces = s.faces()
    if len(faces) > 400:
        faces = faces[:400]
    for f in faces:
        try:
            c = f.center()
            n = f.normal_at(c)
            p = c - n * 1e-3
            inter = BRepIntCurveSurface_Inter()
            inter.Init(s.wrapped, gp_Lin(gp_Pnt(p.X, p.Y, p.Z), gp_Dir(-n.X, -n.Y, -n.Z)), 1e-6)
            while inter.More():
                d = inter.W()
                if d > 1e-3:
                    best = d if best is None else min(best, d)
                    break
                inter.Next()
        except Exception:
            continue
    return round(best, 4) if best is not None else None


def diff(vdir_a: str, vdir_b: str) -> dict:
    import build123d as bd
    A = [s for _n, s, _c in load_parts(vdir_a)]
    B = [s for _n, s, _c in load_parts(vdir_b)]
    ca = A[0] if len(A) == 1 else bd.Compound(children=A)
    cb = B[0] if len(B) == 1 else bd.Compound(children=B)
    out = {"volume_a": round(ca.volume, 4), "volume_b": round(cb.volume, 4)}
    try:
        added = cb - ca
        removed = ca - cb
        out["volume_added"] = round(added.volume, 4) if added else 0.0
        out["volume_removed"] = round(removed.volume, 4) if removed else 0.0
    except Exception as e:
        out["boolean_error"] = str(e)
    fa = {(f.geom_type.name, round(f.area, 3), tuple(round(x, 3) for x in tuple(f.center()))) for f in ca.faces()}
    fb = {(f.geom_type.name, round(f.area, 3), tuple(round(x, 3) for x in tuple(f.center()))) for f in cb.faces()}
    out["faces_a"], out["faces_b"] = len(fa), len(fb)
    out["faces_added"] = len(fb - fa)
    out["faces_removed"] = len(fa - fb)
    bba, bbb = ca.bounding_box(), cb.bounding_box()
    out["bbox_change"] = [round(b - a, 4) for a, b in zip(tuple(bba.size), tuple(bbb.size))]
    out["identical"] = out["faces_added"] == 0 and out["faces_removed"] == 0 and \
        abs(out["volume_a"] - out["volume_b"]) < 1e-6
    return out


def interference(vdir: str, tolerance: float = 1e-3) -> dict:
    """Pairwise clash detection between parts of an assembly: overlapping volume per pair."""
    parts = load_parts(vdir)
    boxes = [s.bounding_box() for _n, s, _c in parts]
    clashes, checked = [], 0
    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            a, b = boxes[i], boxes[j]
            if (a.min.X > b.max.X or b.min.X > a.max.X or a.min.Y > b.max.Y or b.min.Y > a.max.Y
                    or a.min.Z > b.max.Z or b.min.Z > a.max.Z):
                continue
            checked += 1
            try:
                common = parts[i][1] & parts[j][1]
                vol = common.volume if common is not None else 0.0
            except Exception:
                continue
            if vol > tolerance:
                c = common.center()
                clashes.append({"a": f"p{i}", "b": f"p{j}", "a_name": parts[i][0], "b_name": parts[j][0],
                                "volume_mm3": round(vol, 4), "center": [round(x, 3) for x in tuple(c)]})
    clashes.sort(key=lambda c: -c["volume_mm3"])
    return {"parts": len(parts), "pairs_checked": checked, "clashes": clashes, "ok": not clashes}


def bom(vdir: str, density: float | None = None) -> dict:
    """Bill of materials: identical parts (same volume, area and face count) grouped with quantities."""
    parts = load_parts(vdir)
    groups: dict = {}
    for i, (name, s, _c) in enumerate(parts):
        bb = s.bounding_box()
        size = sorted(round(x, 2) for x in tuple(bb.size))
        key = (round(s.volume, 2), round(s.area, 2), len(s.faces()), tuple(size))
        g = groups.setdefault(key, {"name": name, "quantity": 0, "ids": [], "volume_mm3": round(s.volume, 3),
                                    "size_mm": [round(x, 2) for x in tuple(bb.size)], "faces": len(s.faces())})
        g["quantity"] += 1
        g["ids"].append(f"p{i}")
        if density:
            g["mass_g_each"] = round(s.volume / 1000 * density, 3)
    items = sorted(groups.values(), key=lambda g: (-g["quantity"], g["name"]))
    for n, it in enumerate(items, 1):
        it["item"] = n
    return {"items": items, "unique_parts": len(items), "total_parts": len(parts)}
