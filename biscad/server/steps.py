"""Build-step capture: replay how a part was built, one operation at a time.

Every build123d operation funnels geometry through `Builder._add_to_context`. We wrap it,
and after each call that changed a BuildPart we snapshot the part, the operation name, the
script line, and the key arguments. Descriptions are written in short, controlled sentences
(ASD-STE100 style: one instruction per sentence, active voice, simple verbs) so a human can
review an agent's model at a glance.
"""
from __future__ import annotations

import sys

OP_VERBS = {
    "extrude": "Extrude", "revolve": "Revolve", "loft": "Loft", "sweep": "Sweep",
    "fillet": "Fillet", "chamfer": "Chamfer", "offset": "Shell", "mirror": "Mirror",
    "split": "Split", "thicken": "Thicken", "section": "Section", "project": "Project",
    "make_brake_formed": "Bend", "add": "Add", "scale": "Scale",
    "Box": "Add a box", "Cylinder": "Add a cylinder", "Sphere": "Add a sphere", "Cone": "Add a cone",
    "Torus": "Add a torus", "Wedge": "Add a wedge", "Hole": "Drill a hole",
    "CounterBoreHole": "Drill a counterbored hole", "CounterSinkHole": "Drill a countersunk hole",
}
ICON = {
    "extrude": "extrude", "revolve": "revolve", "loft": "loft", "sweep": "sweep", "fillet": "fillet",
    "chamfer": "chamfer", "offset": "shell", "mirror": "mirror", "split": "split", "Hole": "hole",
    "CounterBoreHole": "hole", "CounterSinkHole": "hole", "Box": "primitive", "Cylinder": "primitive",
    "Sphere": "primitive", "Cone": "primitive", "Torus": "primitive", "Wedge": "primitive",
}
ARG_NAMES = ("amount", "radius", "length", "width", "height", "depth", "angle", "revolution_arc",
             "counter_bore_radius", "counter_sink_radius", "length2", "thickness", "until")
MAX_STEPS = 80
LABELS = {"CounterBoreHole": "counterbored hole", "CounterSinkHole": "countersunk hole", "Hole": "hole",
          "offset": "shell", "make_brake_formed": "bend", "Box": "box", "Cylinder": "cylinder",
          "Sphere": "sphere", "Cone": "cone", "Torus": "torus", "Wedge": "wedge"}


def _fmt(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return f"{v:g}"
    name = getattr(v, "name", None)
    if isinstance(name, str):
        return name.lower()
    return None


class StepRecorder:
    def __init__(self):
        self.steps = []
        self._orig = None

    def install(self):
        from build123d import build_common
        from build123d import BuildPart, Mode
        rec = self
        orig = build_common.Builder._add_to_context
        self._orig = orig

        def wrapped(builder, *objects, **kw):
            before = builder._obj if isinstance(builder, BuildPart) else None
            result = orig(builder, *objects, **kw)
            try:
                if isinstance(builder, BuildPart) and kw.get("mode", Mode.ADD) != Mode.PRIVATE \
                        and builder._obj is not None and builder._obj is not before \
                        and len(rec.steps) < MAX_STEPS:
                    rec._record(builder, kw.get("mode", Mode.ADD))
            except Exception:
                pass
            return result

        build_common.Builder._add_to_context = wrapped

    def uninstall(self):
        if self._orig is not None:
            from build123d import build_common
            build_common.Builder._add_to_context = self._orig

    def _record(self, builder, mode):
        # Frames between the user's script and this call
        chain = []
        f = sys._getframe(2)
        line = None
        while f is not None:
            if f.f_code.co_filename == "<script>":
                line = f.f_lineno
                break
            chain.append(f)
            f = f.f_back
        op, args, src_frame = "operation", {}, None
        from build123d import Shape
        for fr in reversed(chain):                      # script side first
            nm = fr.f_code.co_name
            slf = fr.f_locals.get("self")
            if isinstance(slf, Shape):
                op, src_frame = type(slf).__name__, fr
                for a, attr in (("radius", "radius"), ("length", "length"), ("width", "width"),
                                ("height", "height"), ("height", "cylinder_height"), ("depth", "hole_depth"),
                                ("angle", "angle")):
                    s = _fmt(getattr(slf, attr, None)) if a not in args else None
                    if s is not None and s not in ("0",) and len(s) < 20:
                        args[a] = s
                break
        if src_frame is None:
            for fr in reversed(chain):
                nm = fr.f_code.co_name
                if not nm.startswith("_") and nm not in ("wrapper", "wrapped", "inner"):
                    op, src_frame = nm, fr
                    break
        if src_frame is None and chain:
            nm = chain[-1].f_code.co_name
            op = "sketch" if nm == "__exit__" else nm.strip("_")
        if src_frame is not None:
            loc = src_frame.f_locals
            for a in ARG_NAMES:
                if a in loc:
                    s = _fmt(loc[a])
                    if s is not None:
                        args[a] = s
            if "objects" in loc and op in ("fillet", "chamfer"):
                try:
                    args["count"] = str(len(list(loc["objects"])))
                except Exception:
                    pass
        part = builder.part
        if "depth" in args and op.endswith("Hole"):
            try:
                if float(args["depth"]) >= 0.9 * part.bounding_box().diagonal:
                    del args["depth"]
            except Exception:
                pass
        self.steps.append({
            "op": op, "mode": getattr(mode, "name", str(mode)).lower(), "line": line, "args": args,
            "builder": id(builder), "shape": part,
        })


def describe(step, prev_volume, volume, faces):
    op, mode, a = step["op"], step["mode"], step["args"]
    dv = volume - (prev_volume or 0.0)
    verb = OP_VERBS.get(op, op.replace("_", " ").capitalize())
    s = []
    if op == "extrude":
        amt = a.get("amount")
        if mode == "subtract":
            s.append(f"Cut the sketch {amt} mm into the part." if amt else "Cut the sketch into the part.")
        else:
            s.append(f"Extrude the sketch {amt} mm." if amt else "Extrude the sketch.")
    elif op == "revolve":
        s.append(f"Revolve the sketch {a.get('revolution_arc', '360')}°.")
    elif op in ("fillet", "chamfer"):
        n = a.get("count")
        size = a.get("radius") or a.get("length")
        what = f"{n} edges" if n and n != "1" else "1 edge" if n == "1" else "the edges"
        s.append(f"{verb} {what}" + (f" with {'radius' if op == 'fillet' else 'size'} {size} mm." if size else "."))
    elif op == "offset":
        s.append(f"Shell the part. Wall thickness is {a.get('amount', '?').lstrip('-')} mm.")
    elif op in ("Hole", "CounterBoreHole", "CounterSinkHole"):
        r = a.get("radius")
        d = f"{float(r) * 2:g}" if r else None
        s.append(f"{verb}" + (f" of diameter {d} mm" if d else "") +
                 (f", {a['depth']} mm deep." if a.get("depth") else ", through the part."))
    elif op == "Box":
        s.append(f"Add a box {a.get('length', '?')} × {a.get('width', '?')} × {a.get('height', '?')} mm.")
    elif op == "Cylinder":
        r = a.get("radius")
        s.append(f"Add a cylinder of diameter {float(r) * 2:g} mm, height {a.get('height', '?')} mm." if r else "Add a cylinder.")
    elif op == "Sphere":
        r = a.get("radius")
        s.append(f"Add a sphere of diameter {float(r) * 2:g} mm." if r else "Add a sphere.")
    else:
        s.append(f"{verb}.")
    if mode == "subtract" and op not in ("extrude",) and not op.endswith("Hole"):
        s[0] = s[0].rstrip(".") + ". Remove this material."
    elif mode == "intersect":
        s[0] = s[0].rstrip(".") + ". Keep only the overlap."
    if abs(dv) > 1e-6:
        s.append(f"Volume {'increases' if dv > 0 else 'decreases'} by {abs(dv):,.0f} mm³.")
    s.append(f"The part has {faces} faces.")
    return " ".join(s)


def finalize(recorder: StepRecorder):
    """-> list of (meta, shape). Keeps every recorded BuildPart step, in order."""
    out = []
    prev_vol = {}
    for st in recorder.steps:
        shp = st["shape"]
        try:
            vol = float(shp.volume)
            faces = len(shp.faces())
        except Exception:
            vol, faces = 0.0, 0
        pv = prev_vol.get(st["builder"])
        if pv is not None and abs(vol - pv[0]) < 1e-6 and faces == pv[1]:
            continue
        meta = {
            "index": len(out), "op": st["op"], "label": LABELS.get(st["op"], st["op"].replace("_", " ")), "icon": ICON.get(st["op"], st["op"] if st["op"] in ICON.values() else "operation"),
            "mode": st["mode"], "line": st["line"], "args": st["args"],
            "volume": round(vol, 3), "faces": faces, "builder": st["builder"],
            "description": describe(st, pv[0] if pv else None, vol, faces),
        }
        prev_vol[st["builder"]] = (vol, faces)
        out.append((meta, shp))
    # builder ids -> small ints for the client
    ids = {}
    for m, _ in out:
        m["builder"] = ids.setdefault(m["builder"], len(ids))
    return out
