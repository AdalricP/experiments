"""Run untrusted build123d programs.

Defence in depth, best effort (deploy inside a container / gVisor for real isolation):
  1. AST guard: only allow-listed imports, no dunder attribute access, no dangerous builtins.
  2. Restricted builtins in the exec namespace.
  3. Every job runs in a forked child (build123d already imported in the parent, so fork is
     cheap) with CPU / memory / file-size rlimits and a wall-clock timeout.
"""
from __future__ import annotations

import ast
import builtins
import io
import json
import multiprocessing as mp
import os
import signal
import time
import traceback
from contextlib import redirect_stdout

ALLOWED_IMPORTS = {
    "build123d", "math", "cmath", "random", "itertools", "functools", "operator", "typing",
    "dataclasses", "enum", "copy", "numpy", "collections", "statistics", "fractions", "decimal",
    "string", "re",
}
# Attribute names a script may never touch (frames, module walks, file I/O)
BANNED_ATTR_PREFIXES = ("export", "import", "write", "read", "save", "load", "dump", "to_file",
                        "from_file", "open", "f_", "gi_", "cr_", "ag_", "tb_", "co_")
BANNED_ATTRS = {
    "os", "sys", "subprocess", "shutil", "builtins", "importlib", "ctypes", "ctypeslib", "socket",
    "pathlib", "tempfile", "io", "requests", "webbrowser", "inspect", "logging", "pickle", "marshal",
    "system", "popen", "spawn", "fork", "kill", "remove", "unlink", "rmdir", "rename", "chmod",
    "tofile", "fromfile", "memmap", "genfromtxt", "fromregex", "DataSource", "lib", "f2py", "testing",
    "distutils", "modules", "mro", "subclasses", "globals", "locals", "vars", "frame", "persistence",
    "available_fonts", "FontManager", "Path", "PathLike", "Mesher", "ExportSVG", "ExportDXF", "Export2D",
    "brep_from_stl", "exporters", "exporters3d", "importers", "mesher", "ezdxf", "Lib3MF", "svgpathtools",
}
# Names removed from the modules a script imports (sanitized copies, see _safe_module)
BANNED_MODULE_NAMES = BANNED_ATTRS | {"export_to_pcbway", "import_svg_as_buildline_code"}
BANNED_NAMES = {
    "open", "exec", "eval", "compile", "__import__", "globals", "locals", "vars", "getattr",
    "setattr", "delattr", "input", "breakpoint", "help", "exit", "quit", "memoryview",
    "__builtins__", "__loader__", "__spec__",
}

SAFE_BUILTINS = {
    k: getattr(builtins, k) for k in dir(builtins)
    if not k.startswith("_") and k not in BANNED_NAMES
}

_real_import = builtins.__import__
_safe_cache: dict = {}


def _banned_name(n: str) -> bool:
    return n in BANNED_MODULE_NAMES or n.startswith(BANNED_ATTR_PREFIXES)


def _safe_module(name: str):
    """A copy of a module holding only public, non-module, non-I/O attributes. Scripts never
    see real modules, so `typing.sys`, `re.enum.sys`, `build123d.os` etc. do not exist."""
    import types
    if name in _safe_cache:
        return _safe_cache[name]
    real = _real_import(name)
    for part in name.split(".")[1:]:
        real = getattr(real, part)
    safe = types.ModuleType(name)
    for attr in dir(real):
        if attr.startswith("_") or _banned_name(attr):
            continue
        try:
            val = getattr(real, attr)
        except Exception:
            continue
        if isinstance(val, types.ModuleType):
            continue
        setattr(safe, attr, val)
    _safe_cache[name] = safe
    return safe


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0 or name not in ALLOWED_IMPORTS:
        raise ImportError(f"import of '{name}' is not allowed in Voncad scripts")
    return _safe_module(name)


SAFE_BUILTINS["__import__"] = _guarded_import


class ScriptError(Exception):
    pass


def check_script(src: str) -> ast.Module:
    try:
        tree = ast.parse(src, "<script>")
    except SyntaxError as e:
        raise ScriptError(f"SyntaxError: {e.msg} (line {e.lineno})")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.ImportFrom) and node.level:
                raise ScriptError(f"line {node.lineno}: relative imports are not allowed")
            names = [node.module] if isinstance(node, ast.ImportFrom) else [a.name for a in node.names]
            for n in names:
                if (n or "") not in ALLOWED_IMPORTS:
                    raise ScriptError(f"line {node.lineno}: import of '{n}' is not allowed "
                                      f"(allowed: {', '.join(sorted(ALLOWED_IMPORTS))})")
            if isinstance(node, ast.ImportFrom):
                for a in node.names:
                    if a.name != "*" and _banned_name(a.name):
                        raise ScriptError(f"line {node.lineno}: '{a.name}' is not available in Voncad scripts")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ScriptError(f"line {node.lineno}: dunder attribute access is not allowed")
        elif isinstance(node, ast.Attribute) and _banned_name(node.attr):
            raise ScriptError(f"line {node.lineno}: '.{node.attr}' is not available in Voncad scripts "
                              "(no file, OS or introspection access; the server exports for you)")
        elif isinstance(node, ast.Name) and (node.id in BANNED_NAMES or node.id.startswith("__")
                                             or _banned_name(node.id)):
            raise ScriptError(f"line {node.lineno}: '{node.id}' is not available in Voncad scripts")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and "__" in node.value:
            raise ScriptError(f"line {node.lineno}: strings containing '__' are not allowed")
    return tree


def param_schema(src: str) -> list[dict]:
    """Defaults from a top-level `params = {...}` literal."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "params" for t in node.targets):
            try:
                val = ast.literal_eval(node.value)
            except Exception:
                return []
            if isinstance(val, dict):
                out = []
                for k, v in val.items():
                    typ = "bool" if isinstance(v, bool) else "int" if isinstance(v, int) else \
                          "float" if isinstance(v, float) else "string"
                    out.append({"name": str(k), "default": v, "type": typ})
                return out
    return []


def apply_params(tree: ast.Module, overrides: dict | None) -> ast.Module:
    """Rewrite `params = {...}` into `params = {**{...}, **__vc_params}`."""
    if not overrides:
        return tree
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "params" for t in node.targets):
            node.value = ast.Dict(keys=[None, None], values=[node.value, ast.Name("__vc_params", ast.Load())])
            ast.fix_missing_locations(tree)
            return tree
    # no params dict in the script: define one
    assign = ast.parse("params = dict(__vc_params)").body[0]
    tree.body.insert(0, assign)
    ast.fix_missing_locations(tree)
    return tree


def _coerce(overrides, schema):
    types = {s["name"]: s["type"] for s in schema}
    out = {}
    for k, v in (overrides or {}).items():
        t = types.get(k)
        try:
            if t == "int":
                v = int(round(float(v)))
            elif t == "float":
                v = float(v)
            elif t == "bool":
                v = v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
        except Exception:
            pass
        out[k] = v
    return out


# ---------------------------------------------------------------- isolation

def _limit(mem_mb: int, cpu_s: int):
    import resource
    try:
        resource.setrlimit(resource.RLIMIT_AS, (mem_mb << 20, mem_mb << 20))
    except Exception:
        pass
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 1))
    except Exception:
        pass
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 << 20, 512 << 20))
    except Exception:
        pass


def _child(conn, fn, args, mem_mb, cpu_s):
    try:
        os.setsid()
    except Exception:
        pass
    _limit(mem_mb, cpu_s)
    try:
        conn.send(("ok", fn(*args)))
    except BaseException as e:  # noqa: BLE001 - report everything to the parent
        line = None
        tb = e.__traceback__
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == "<script>":
                line = tb.tb_lineno
            tb = tb.tb_next
        msg = f"{type(e).__name__}: {e}" + (f" (line {line})" if line and "(line" not in str(e) else "")
        conn.send(("err", msg, traceback.format_exc(limit=6)))
    finally:
        conn.close()


_ctx = mp.get_context("fork")


def isolated(fn, *args, timeout=60.0, mem_mb=3072):
    """Run fn(*args) in a forked child. Returns its result or raises ScriptError."""
    parent, child = _ctx.Pipe(duplex=False)
    p = _ctx.Process(target=_child, args=(child, fn, args, mem_mb, int(timeout) + 5), daemon=True)
    p.start()
    child.close()
    try:
        if not parent.poll(timeout):
            raise ScriptError(f"timed out after {timeout:.0f}s")
        msg = parent.recv()
    except EOFError:
        raise ScriptError("kernel process crashed (out of memory or invalid geometry)")
    finally:
        if p.is_alive():
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except Exception:
                p.kill()
        p.join(1)
        parent.close()
    if msg[0] == "ok":
        return msg[1]
    raise ScriptError(msg[1])


# ---------------------------------------------------------------- build job

def _find_result(ns: dict, shown: list):
    if shown:
        return shown if len(shown) > 1 else shown[0]
    if ns.get("result") is not None:
        return ns["result"]
    from build123d import BuildPart, Shape
    cands = [v for k, v in ns.items() if not k.startswith("_") and isinstance(v, (BuildPart, Shape))
             and type(v).__module__.startswith("build123d")]
    if cands:
        return cands[-1]
    return None


def _union_bbox(parts_summary):
    lo = [min(p["bbox"]["min"][k] for p in parts_summary) for k in range(3)]
    hi = [max(p["bbox"]["max"][k] for p in parts_summary) for k in range(3)]
    return {"min": lo, "max": hi}


def summarize(parts):
    from build123d import CenterOf
    out, vol, area = [], 0.0, 0.0
    com_acc = [0.0, 0.0, 0.0]
    for i, (name, s, _c) in enumerate(parts):
        bb = s.bounding_box()
        v = float(getattr(s, "volume", 0.0) or 0.0)
        a = float(getattr(s, "area", 0.0) or 0.0)
        vol += v
        area += a
        try:
            c = s.center(center_of=CenterOf.MASS) if v > 0 else s.center()
            for k in range(3):
                com_acc[k] += tuple(c)[k] * v
        except Exception:
            pass
        out.append({
            "id": f"p{i}", "name": name, "volume": round(v, 4), "area": round(a, 4),
            "bbox": {"min": [round(x, 4) for x in tuple(bb.min)],
                     "max": [round(x, 4) for x in tuple(bb.max)],
                     "size": [round(x, 4) for x in tuple(bb.size)]},
            "solids": len(s.solids()), "faces": len(s.faces()), "edges": len(s.edges()),
            "valid": bool(s.is_valid() if callable(s.is_valid) else s.is_valid),
        })
    com = [round(x / vol, 4) for x in com_acc] if vol > 0 else None
    return {"parts": out, "volume": round(vol, 4), "area": round(area, 4), "center_of_mass": com,
            "mass_g_steel": round(vol / 1000 * 7.85, 3), "mass_g_aluminium": round(vol / 1000 * 2.70, 3),
            "mass_g_pla": round(vol / 1000 * 1.24, 3)}


def write_shape_dir(parts, outdir, light=False):
    """Mesh + persist [(name, shape, color)] into outdir. Returns (scene, bufs)."""
    import numpy as np
    import build123d as bd
    from tessellate import build_scene

    os.makedirs(outdir, exist_ok=True)
    scene, bufs, topo = build_scene(parts)
    with open(os.path.join(outdir, "scene.json"), "w") as f:
        json.dump(scene, f, separators=(",", ":"))
    with open(os.path.join(outdir, "topology.json"), "w") as f:
        json.dump(topo, f, separators=(",", ":"))
    arrays = {}
    for i, b in enumerate(bufs):
        arrays[f"p{i}_pos"] = b["positions"].astype(np.float32)
        arrays[f"p{i}_nrm"] = b["normals"].astype(np.float32)
        arrays[f"p{i}_idx"] = b["indices"].astype(np.uint32)
        segs = []
        for pl in b["polylines"]:
            if pl is not None and len(pl) >= 2:
                segs.append(np.stack([pl[:-1], pl[1:]], 1).reshape(-1, 3))
        arrays[f"p{i}_edges"] = (np.concatenate(segs) if segs else np.zeros((0, 3))).astype(np.float32)
    np.savez_compressed(os.path.join(outdir, "mesh.npz"), **arrays)
    colors = [p["color"] for p in scene["parts"]]
    with open(os.path.join(outdir, "parts.json"), "w") as f:
        json.dump([{"name": n, "color": col} for (n, _s, _c), col in zip(parts, colors)], f)
    if not light:
        for i, (_n, s, _c) in enumerate(parts):
            bd.export_brep(s, os.path.join(outdir, f"part{i}.brep"))
    return scene, bufs


def _build_job(src: str, overrides: dict, outdir: str, quality: str = "normal"):
    from steps import StepRecorder, finalize
    from tessellate import flatten_parts, set_quality

    set_quality(quality)

    t0 = time.time()
    tree = check_script(src)
    schema = param_schema(src)
    tree = apply_params(tree, _coerce(overrides, schema))
    code = compile(tree, "<script>", "exec")
    shown = []

    def show(*objs, **named):
        for o in objs:
            shown.append(o)
        for k, o in named.items():
            try:
                o.label = k
            except Exception:
                pass
            shown.append(o)

    ns = {"__builtins__": SAFE_BUILTINS, "__name__": "__voncad__", "show": show, "show_object": show,
          "__vc_params": _coerce(overrides, schema)}
    out = io.StringIO()
    rec = StepRecorder()
    rec.install()
    import resource
    import signal as _signal
    old_fsize = resource.getrlimit(resource.RLIMIT_FSIZE)
    try:
        # No file writes while user code runs (soft limit only; restored for our own outputs)
        _signal.signal(_signal.SIGXFSZ, _signal.SIG_IGN)
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, old_fsize[1]))
        with redirect_stdout(out):
            exec(code, ns)
    finally:
        resource.setrlimit(resource.RLIMIT_FSIZE, old_fsize)
        rec.uninstall()
    t_exec = time.time() - t0
    res = _find_result(ns, shown)
    if res is None:
        raise ScriptError("script produced no geometry: assign it to `result` or call show(...)")
    parts = flatten_parts(res)
    if not parts:
        raise ScriptError("`result` is not a build123d shape")
    scene, bufs = write_shape_dir(parts, outdir)
    # build steps: one light directory per step (scene + mesh, no B-rep)
    steps_meta = []
    set_quality("draft")            # step snapshots are previews: mesh them coarse and fast
    for meta, shp in finalize(rec):
        sdir = os.path.join(outdir, "steps", str(meta["index"]))
        try:
            write_shape_dir([(f"step {meta['index']}", shp, "#d9d7d2")], sdir, light=True)
            meta["has_scene"] = True
        except Exception:
            meta["has_scene"] = False
        steps_meta.append(meta)
    set_quality(quality)
    with open(os.path.join(outdir, "steps.json"), "w") as f:
        json.dump(steps_meta, f)
    summary = summarize(parts)
    summary["bbox"] = _union_bbox(summary["parts"])
    summary["timing_ms"] = {"exec": round(t_exec * 1000), "total": round((time.time() - t0) * 1000)}
    summary["triangles"] = int(sum(len(b["indices"]) for b in bufs))
    summary["steps"] = len(steps_meta)
    return {"summary": summary, "logs": out.getvalue()[-20000:], "param_schema": schema, "steps": steps_meta}


def build(src: str, overrides: dict | None, outdir: str, timeout: float = 60.0, quality: str = "normal") -> dict:
    """Returns {ok, summary?, error?, logs, param_schema}."""
    schema = param_schema(src)
    try:
        check_script(src)  # fast fail without forking
        res = isolated(_build_job, src, overrides or {}, outdir, quality, timeout=timeout)
        return {"ok": True, **res}
    except ScriptError as e:
        return {"ok": False, "error": str(e), "logs": "", "param_schema": schema}


# ---------------------------------------------------------------- loading versions

def load_parts(vdir: str):
    """[(name, shape, color)] from a built version directory (call inside a child)."""
    import build123d as bd
    meta = json.load(open(os.path.join(vdir, "parts.json")))
    out = []
    for i, m in enumerate(meta):
        s = bd.import_brep(os.path.join(vdir, f"part{i}.brep"))
        s.label = m["name"]
        out.append((m["name"], s, m.get("color")))
    return out
