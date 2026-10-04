from __future__ import annotations

import ast
import builtins
import contextlib
import io
import json
import multiprocessing
import os
import resource
import signal
import time
import traceback
import types
from contextlib import redirect_stdout

import build123d as bd
import numpy as np

import constraint_sketch

from steps import StepRecorder, finalize_recorded_steps
from tessellate import build_scene_and_topology, flatten_into_leaf_parts, set_mesh_quality

ALLOWED_IMPORTS = {
    "build123d", "math", "cmath", "random", "itertools", "functools", "operator", "typing",
    "dataclasses", "enum", "copy", "numpy", "collections", "statistics", "fractions", "decimal",
    "string", "re", "constraint_sketch",
}
MODULES_PRELOADED_FOR_WARM_FORKED_WORKERS = (constraint_sketch,)
BANNED_ATTRIBUTE_NAME_PREFIXES = ("export", "import", "write", "read", "save", "load", "dump", "to_file",
                                  "from_file", "open", "f_", "gi_", "cr_", "ag_", "tb_", "co_")
BANNED_ATTRIBUTE_NAMES = {
    "os", "sys", "subprocess", "shutil", "builtins", "importlib", "ctypes", "ctypeslib", "socket",
    "pathlib", "tempfile", "io", "requests", "webbrowser", "inspect", "logging", "pickle", "marshal",
    "system", "popen", "spawn", "fork", "kill", "remove", "unlink", "rmdir", "rename", "chmod",
    "tofile", "fromfile", "memmap", "genfromtxt", "fromregex", "DataSource", "lib", "f2py", "testing",
    "distutils", "modules", "mro", "subclasses", "globals", "locals", "vars", "frame", "persistence",
    "available_fonts", "FontManager", "Path", "PathLike", "Mesher", "ExportSVG", "ExportDXF", "Export2D",
    "brep_from_stl", "exporters", "exporters3d", "importers", "mesher", "ezdxf", "Lib3MF", "svgpathtools",
}
BANNED_MODULE_MEMBER_NAMES = BANNED_ATTRIBUTE_NAMES | {"export_to_pcbway", "import_svg_as_buildline_code"}
BANNED_NAMES = {
    "open", "exec", "eval", "compile", "__import__", "globals", "locals", "vars", "getattr",
    "setattr", "delattr", "input", "breakpoint", "help", "exit", "quit", "memoryview",
    "__builtins__", "__loader__", "__spec__",
}
SAFE_BUILTINS = {
    name: getattr(builtins, name) for name in dir(builtins)
    if not name.startswith("_") and name not in BANNED_NAMES
}
MAX_FILE_SIZE_IN_BYTES_FOR_CHILD = 512 << 20
MAX_CAPTURED_LOG_CHARACTERS = 20000
STEP_PREVIEW_COLOR = "#d9d7d2"
PARAMETER_OVERRIDES_NAME = "__parameter_overrides"
TRUTHY_STRINGS = ("1", "true", "yes", "on")

_unrestricted_import = builtins.__import__
_sanitized_module_cache: dict = {}
_fork_context = multiprocessing.get_context("fork")


class ScriptError(Exception):
    pass


def _is_banned_name(name: str) -> bool:
    return name in BANNED_MODULE_MEMBER_NAMES or name.startswith(BANNED_ATTRIBUTE_NAME_PREFIXES)


def _exposable_module_members(real_module) -> dict:
    members = {}
    for member_name in dir(real_module):
        if member_name.startswith("_") or _is_banned_name(member_name):
            continue
        try:
            member = getattr(real_module, member_name)
        except Exception:
            continue
        if not isinstance(member, types.ModuleType):
            members[member_name] = member
    return members


def _sanitized_copy_of_module(module_name: str):
    if module_name in _sanitized_module_cache:
        return _sanitized_module_cache[module_name]
    real_module = _unrestricted_import(module_name)
    for submodule_name in module_name.split(".")[1:]:
        real_module = getattr(real_module, submodule_name)
    sanitized_module = types.ModuleType(module_name)
    sanitized_module.__dict__.update(_exposable_module_members(real_module))
    _sanitized_module_cache[module_name] = sanitized_module
    return sanitized_module


def _guarded_import(module_name, global_namespace=None, local_namespace=None, imported_names=(), relative_level=0):
    if relative_level != 0 or module_name not in ALLOWED_IMPORTS:
        raise ImportError(f"import of '{module_name}' is not allowed in BISCAD scripts")
    return _sanitized_copy_of_module(module_name)


SAFE_BUILTINS["__import__"] = _guarded_import


def _reject_forbidden_import(node: ast.Import | ast.ImportFrom):
    is_from_import = isinstance(node, ast.ImportFrom)
    if is_from_import and node.level:
        raise ScriptError(f"line {node.lineno}: relative imports are not allowed")
    module_names = [node.module] if is_from_import else [alias.name for alias in node.names]
    for module_name in module_names:
        if (module_name or "") not in ALLOWED_IMPORTS:
            raise ScriptError(f"line {node.lineno}: import of '{module_name}' is not allowed "
                              f"(allowed: {', '.join(sorted(ALLOWED_IMPORTS))})")
    imported_member_names = [alias.name for alias in node.names] if is_from_import else []
    for member_name in imported_member_names:
        if member_name != "*" and _is_banned_name(member_name):
            raise ScriptError(f"line {node.lineno}: '{member_name}' is not available in BISCAD scripts")


def _reject_forbidden_attribute(node: ast.Attribute):
    if node.attr.startswith("__"):
        raise ScriptError(f"line {node.lineno}: dunder attribute access is not allowed")
    if _is_banned_name(node.attr):
        raise ScriptError(f"line {node.lineno}: '.{node.attr}' is not available in BISCAD scripts "
                          "(no file, OS or introspection access; the server exports for you)")


def _reject_forbidden_node(node: ast.AST):
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        _reject_forbidden_import(node)
    if isinstance(node, ast.Attribute):
        _reject_forbidden_attribute(node)
    if isinstance(node, ast.Name) and (node.id in BANNED_NAMES or node.id.startswith("__") or _is_banned_name(node.id)):
        raise ScriptError(f"line {node.lineno}: '{node.id}' is not available in BISCAD scripts")
    if isinstance(node, ast.Constant) and isinstance(node.value, str) and "__" in node.value:
        raise ScriptError(f"line {node.lineno}: strings containing '__' are not allowed")


def parse_and_check_script(script_source: str) -> ast.Module:
    try:
        syntax_tree = ast.parse(script_source, "<script>")
    except SyntaxError as syntax_error:
        raise ScriptError(f"SyntaxError: {syntax_error.msg} (line {syntax_error.lineno})")
    for node in ast.walk(syntax_tree):
        _reject_forbidden_node(node)
    return syntax_tree


def _params_assignments(syntax_tree: ast.Module):
    return [node for node in syntax_tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "params" for target in node.targets)]


def _parameter_type_name(default) -> str:
    if isinstance(default, bool):
        return "bool"
    if isinstance(default, int):
        return "int"
    return "float" if isinstance(default, float) else "string"


def parameter_schema_from_script(script_source: str) -> list[dict]:
    try:
        syntax_tree = ast.parse(script_source)
    except SyntaxError:
        return []
    for assignment in _params_assignments(syntax_tree):
        try:
            default_params = ast.literal_eval(assignment.value)
        except Exception:
            return []
        if isinstance(default_params, dict):
            return [{"name": str(name), "default": default, "type": _parameter_type_name(default)}
                    for name, default in default_params.items()]
    return []


def inject_parameter_overrides(syntax_tree: ast.Module, overrides: dict | None) -> ast.Module:
    if not overrides:
        return syntax_tree
    params_assignments = _params_assignments(syntax_tree)
    if params_assignments:
        params_assignments[0].value = ast.Dict(keys=[None, None], values=[
            params_assignments[0].value, ast.Name(PARAMETER_OVERRIDES_NAME, ast.Load())])
    else:
        syntax_tree.body.insert(0, ast.parse(f"params = dict({PARAMETER_OVERRIDES_NAME})").body[0])
    ast.fix_missing_locations(syntax_tree)
    return syntax_tree


def _coerce_override(raw_value, type_name: str | None):
    try:
        if type_name == "int":
            return int(round(float(raw_value)))
        if type_name == "float":
            return float(raw_value)
        if type_name == "bool":
            return raw_value if isinstance(raw_value, bool) else str(raw_value).lower() in TRUTHY_STRINGS
    except Exception:
        return raw_value
    return raw_value


def _coerce_overrides_to_schema_types(overrides: dict | None, schema: list[dict]) -> dict:
    type_names = {parameter["name"]: parameter["type"] for parameter in schema}
    return {name: _coerce_override(raw_value, type_names.get(name)) for name, raw_value in (overrides or {}).items()}


def _apply_child_resource_limits(memory_limit_in_megabytes: int, cpu_limit_in_seconds: int):
    limits = ((resource.RLIMIT_AS, memory_limit_in_megabytes << 20, memory_limit_in_megabytes << 20),
              (resource.RLIMIT_CPU, cpu_limit_in_seconds, cpu_limit_in_seconds + 1),
              (resource.RLIMIT_FSIZE, MAX_FILE_SIZE_IN_BYTES_FOR_CHILD, MAX_FILE_SIZE_IN_BYTES_FOR_CHILD))
    for limit_kind, soft_limit, hard_limit in limits:
        with contextlib.suppress(Exception):
            resource.setrlimit(limit_kind, (soft_limit, hard_limit))


def _last_script_line_in_traceback(error: BaseException) -> int | None:
    script_line_number = None
    traceback_entry = error.__traceback__
    while traceback_entry is not None:
        if traceback_entry.tb_frame.f_code.co_filename == "<script>":
            script_line_number = traceback_entry.tb_lineno
        traceback_entry = traceback_entry.tb_next
    return script_line_number


def _describe_child_failure(error: BaseException) -> str:
    script_line_number = _last_script_line_in_traceback(error)
    has_line_already = "(line" in str(error)
    line_suffix = f" (line {script_line_number})" if script_line_number and not has_line_already else ""
    return f"{type(error).__name__}: {error}{line_suffix}"


def _run_in_child_and_report(connection, function, arguments, memory_limit_in_megabytes, cpu_limit_in_seconds):
    with contextlib.suppress(Exception):
        os.setsid()
    _apply_child_resource_limits(memory_limit_in_megabytes, cpu_limit_in_seconds)
    try:
        connection.send(("ok", function(*arguments)))
    except BaseException as child_error:
        connection.send(("err", _describe_child_failure(child_error), traceback.format_exc(limit=6)))
    finally:
        connection.close()


def _kill_child_process_group(child_process):
    if not child_process.is_alive():
        return
    try:
        os.killpg(child_process.pid, signal.SIGKILL)
    except Exception:
        child_process.kill()


def run_in_forked_child(function, *arguments, timeout_in_seconds=60.0, memory_limit_in_megabytes=3072):
    parent_end, child_end = _fork_context.Pipe(duplex=False)
    child_process = _fork_context.Process(target=_run_in_child_and_report, daemon=True, args=(
        child_end, function, arguments, memory_limit_in_megabytes, int(timeout_in_seconds) + 5))
    child_process.start()
    child_end.close()
    try:
        if not parent_end.poll(timeout_in_seconds):
            raise ScriptError(f"timed out after {timeout_in_seconds:.0f}s")
        child_message = parent_end.recv()
    except EOFError:
        raise ScriptError("kernel process crashed (out of memory or invalid geometry)")
    finally:
        _kill_child_process_group(child_process)
        child_process.join(1)
        parent_end.close()
    if child_message[0] == "ok":
        return child_message[1]
    raise ScriptError(child_message[1])


def _find_result_shape(namespace: dict, shown_shapes: list):
    if shown_shapes:
        return shown_shapes if len(shown_shapes) > 1 else shown_shapes[0]
    if namespace.get("result") is not None:
        return namespace["result"]
    candidates = [candidate for name, candidate in namespace.items()
                  if not name.startswith("_") and isinstance(candidate, (bd.BuildPart, bd.Shape))
                  and type(candidate).__module__.startswith("build123d")]
    return candidates[-1] if candidates else None


def union_bounding_box_of_part_summaries(part_summaries: list[dict]) -> dict:
    return {"min": [min(part["bbox"]["min"][axis] for part in part_summaries) for axis in range(3)],
            "max": [max(part["bbox"]["max"][axis] for part in part_summaries) for axis in range(3)]}


def is_shape_valid(shape) -> bool:
    return bool(shape.is_valid() if callable(shape.is_valid) else shape.is_valid)


def _float_property(shape, property_name: str) -> float:
    return float(getattr(shape, property_name, 0.0) or 0.0)


def _volume_weighted_center(shape, volume: float) -> list[float]:
    try:
        center = shape.center(center_of=bd.CenterOf.MASS) if volume > 0 else shape.center()
        return [coordinate * volume for coordinate in tuple(center)]
    except Exception:
        return [0.0, 0.0, 0.0]


def _rounded_to_four_places(values) -> list[float]:
    return [round(component, 4) for component in values]


def _summarize_single_part(part_index: int, name: str, shape, volume: float, area: float) -> dict:
    bounding_box = shape.bounding_box()
    return {
        "id": f"p{part_index}", "name": name, "volume": round(volume, 4), "area": round(area, 4),
        "bbox": {corner: _rounded_to_four_places(tuple(getattr(bounding_box, corner))) for corner in ("min", "max", "size")},
        "solids": len(shape.solids()), "faces": len(shape.faces()), "edges": len(shape.edges()),
        "valid": is_shape_valid(shape),
    }


REFERENCE_DENSITIES_IN_GRAMS_PER_CUBIC_CENTIMETER = {"steel": 7.85, "aluminium": 2.70, "pla": 1.24}


def summarize_parts(parts: list) -> dict:
    volumes = [_float_property(shape, "volume") for _name, shape, _color in parts]
    areas = [_float_property(shape, "area") for _name, shape, _color in parts]
    total_volume = sum(volumes, 0.0)
    weighted_centers = [_volume_weighted_center(shape, volume) for (_name, shape, _color), volume in zip(parts, volumes)]
    center_of_mass = ([round(sum(axis_values, 0.0) / total_volume, 4) for axis_values in zip(*weighted_centers)]
                      if total_volume > 0 else None)
    part_summaries = [_summarize_single_part(part_index, name, shape, volume, area)
                      for part_index, ((name, shape, _color), volume, area) in enumerate(zip(parts, volumes, areas))]
    masses = {f"mass_g_{material}": round(total_volume / 1000 * density, 3)
              for material, density in REFERENCE_DENSITIES_IN_GRAMS_PER_CUBIC_CENTIMETER.items()}
    return {"parts": part_summaries, "volume": round(total_volume, 4), "area": round(sum(areas, 0.0), 4),
            "center_of_mass": center_of_mass, **masses}


def summarize_parts_with_bounding_box(parts: list) -> dict:
    summary = summarize_parts(parts)
    return summary | {"bbox": union_bounding_box_of_part_summaries(summary["parts"])}


def count_triangles(mesh_buffers: list[dict]) -> int:
    return int(sum(len(buffers["indices"]) for buffers in mesh_buffers))


def _edge_segments_from_polylines(polylines: list) -> np.ndarray:
    segments = [np.stack([polyline[:-1], polyline[1:]], 1).reshape(-1, 3)
                for polyline in polylines if polyline is not None and len(polyline) >= 2]
    return (np.concatenate(segments) if segments else np.zeros((0, 3))).astype(np.float32)


def _mesh_arrays_for_part(part_index: int, buffers: dict) -> dict:
    return {f"p{part_index}_pos": buffers["positions"].astype(np.float32),
            f"p{part_index}_nrm": buffers["normals"].astype(np.float32),
            f"p{part_index}_idx": buffers["indices"].astype(np.uint32),
            f"p{part_index}_edges": _edge_segments_from_polylines(buffers["polylines"])}


def _write_json_text(path: str, content, separators=None):
    with open(path, "w") as json_file:
        json_file.write(json.dumps(content, separators=separators))


def _write_compact_json(path: str, content):
    _write_json_text(path, content, separators=(",", ":"))


def write_meshed_parts_to_directory(parts: list, output_directory: str, should_write_brep: bool = True,
                                    lineage_token_by_face: dict | None = None):
    os.makedirs(output_directory, exist_ok=True)
    scene, mesh_buffers, topology = build_scene_and_topology(parts, lineage_token_by_face)
    _write_compact_json(os.path.join(output_directory, "scene.json"), scene)
    _write_compact_json(os.path.join(output_directory, "topology.json"), topology)
    mesh_arrays = {}
    for part_index, buffers in enumerate(mesh_buffers):
        mesh_arrays |= _mesh_arrays_for_part(part_index, buffers)
    np.savez_compressed(os.path.join(output_directory, "mesh.npz"), **mesh_arrays)
    part_colors = [{"name": name, "color": scene_part["color"]}
                   for (name, _shape, _color), scene_part in zip(parts, scene["parts"])]
    _write_json_text(os.path.join(output_directory, "parts.json"), part_colors)
    for part_index, (_name, shape, _color) in enumerate(parts if should_write_brep else []):
        bd.export_brep(shape, os.path.join(output_directory, f"part{part_index}.brep"))
    return scene, mesh_buffers


def _try_set_label(shape, label: str):
    with contextlib.suppress(Exception):
        shape.label = label


def _show_function_collecting_into(shown_shapes: list):
    def show(*shapes, **shapes_by_label):
        shown_shapes.extend(shapes)
        for label, shape in shapes_by_label.items():
            _try_set_label(shape, label)
            shown_shapes.append(shape)
    return show


def _execute_with_file_writes_blocked(compiled_script, namespace: dict, captured_stdout: io.StringIO):
    original_file_size_limit = resource.getrlimit(resource.RLIMIT_FSIZE)
    try:
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, original_file_size_limit[1]))
        with redirect_stdout(captured_stdout):
            exec(compiled_script, namespace)
    finally:
        resource.setrlimit(resource.RLIMIT_FSIZE, original_file_size_limit)


def _try_write_step_scene(step_index: int, step_shape, step_directory: str, lineage_token_by_face: dict) -> bool:
    try:
        write_meshed_parts_to_directory([(f"step {step_index}", step_shape, STEP_PREVIEW_COLOR)], step_directory,
                                        should_write_brep=False, lineage_token_by_face=lineage_token_by_face)
        return True
    except Exception:
        return False


def _write_build_step_snapshots(recorder: StepRecorder, output_directory: str, quality: str) -> list[dict]:
    set_mesh_quality("draft")
    steps_metadata = [
        step_metadata | {"has_scene": _try_write_step_scene(
            step_metadata["index"], step_shape, os.path.join(output_directory, "steps", str(step_metadata["index"])),
            recorder.lineage_token_by_face)}
        for step_metadata, step_shape in finalize_recorded_steps(recorder)]
    set_mesh_quality(quality)
    _write_json_text(os.path.join(output_directory, "steps.json"), steps_metadata)
    return steps_metadata


def _build_script_in_child(script_source: str, overrides: dict, output_directory: str, quality: str = "normal"):
    set_mesh_quality(quality)
    start_time = time.time()
    syntax_tree = parse_and_check_script(script_source)
    schema = parameter_schema_from_script(script_source)
    coerced_overrides = _coerce_overrides_to_schema_types(overrides, schema)
    compiled_script = compile(inject_parameter_overrides(syntax_tree, coerced_overrides), "<script>", "exec")
    shown_shapes = []
    show = _show_function_collecting_into(shown_shapes)
    namespace = {"__builtins__": SAFE_BUILTINS, "__name__": "__biscad__", "show": show, "show_object": show,
                 PARAMETER_OVERRIDES_NAME: coerced_overrides}
    captured_stdout = io.StringIO()
    recorder = StepRecorder()
    recorder.install()
    try:
        _execute_with_file_writes_blocked(compiled_script, namespace, captured_stdout)
    finally:
        recorder.uninstall()
    execution_seconds = time.time() - start_time
    result_shape = _find_result_shape(namespace, shown_shapes)
    if result_shape is None:
        raise ScriptError("script produced no geometry: assign it to `result` or call show(...)")
    parts = flatten_into_leaf_parts(result_shape)
    if not parts:
        raise ScriptError("`result` is not a build123d shape")
    _scene, mesh_buffers = write_meshed_parts_to_directory(parts, output_directory,
                                                           lineage_token_by_face=recorder.lineage_token_by_face)
    steps_metadata = _write_build_step_snapshots(recorder, output_directory, quality)
    summary = summarize_parts_with_bounding_box(parts)
    summary["timing_ms"] = {"exec": round(execution_seconds * 1000), "total": round((time.time() - start_time) * 1000)}
    summary["triangles"] = count_triangles(mesh_buffers)
    summary["steps"] = len(steps_metadata)
    return {"summary": summary, "logs": captured_stdout.getvalue()[-MAX_CAPTURED_LOG_CHARACTERS:],
            "param_schema": schema, "steps": steps_metadata}


def build_script(script_source: str, overrides: dict | None, output_directory: str, timeout_in_seconds: float = 60.0,
                 quality: str = "normal") -> dict:
    schema = parameter_schema_from_script(script_source)
    try:
        parse_and_check_script(script_source)
        built = run_in_forked_child(_build_script_in_child, script_source, overrides or {}, output_directory, quality,
                                    timeout_in_seconds=timeout_in_seconds)
        return {"ok": True, **built}
    except ScriptError as script_error:
        return {"ok": False, "error": str(script_error), "logs": "", "param_schema": schema}


def load_parts_from_version_directory(version_directory: str) -> list:
    with open(os.path.join(version_directory, "parts.json")) as parts_file:
        parts_metadata = json.load(parts_file)
    parts = []
    for part_index, part_metadata in enumerate(parts_metadata):
        shape = bd.import_brep(os.path.join(version_directory, f"part{part_index}.brep"))
        shape.label = part_metadata["name"]
        parts.append((part_metadata["name"], shape, part_metadata.get("color")))
    return parts
