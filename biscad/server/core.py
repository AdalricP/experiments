from __future__ import annotations

import contextlib
import json
import os
import threading
import time

import build123d as bd

import kernel
import store
from tessellate import flatten_into_leaf_parts

MAX_CONCURRENT_KERNEL_WORKERS = int(os.environ.get("BISCAD_WORKERS", max(1, (os.cpu_count() or 2))))
KERNEL_WORKER_WAIT_IN_SECONDS = 120
MAX_SCRIPT_LENGTH_IN_CHARACTERS = 200_000
EDGE_GEOMETRY_TYPES = ("line", "circle", "bspline", "ellipse")
IMPORTABLE_EXTENSIONS = ("step", "stp", "brep", "stl")
_kernel_worker_slots = threading.BoundedSemaphore(MAX_CONCURRENT_KERNEL_WORKERS)
_rate_limit_token_buckets_by_owner: dict[str, list] = {}
_rate_limit_lock = threading.Lock()


class ApiError(Exception):
    def __init__(self, http_status: int, message: str, code: str = "error"):
        super().__init__(message)
        self.http_status, self.message, self.code = http_status, message, code


def identify_caller(authorization_header: str | None, client_ip_address: str | None) -> dict:
    if not authorization_header:
        return {"owner": f"anon:{client_ip_address or 'unknown'}", "plan": "anon", "anonymous": True}
    has_bearer_prefix = authorization_header.lower().startswith("bearer ")
    api_key = (authorization_header.split(" ", 1)[1] if has_bearer_prefix else authorization_header).strip()
    key_row = store.find_api_key_row(api_key)
    if not key_row:
        raise ApiError(401, "invalid API key", "unauthorized")
    return {"owner": key_row["id"], "plan": key_row["plan"], "anonymous": False, "email": key_row["email"]}


def consume_rate_limit_token(caller: dict):
    requests_per_minute = store.PLANS[caller["plan"]]["rpm"]
    now = time.time()
    with _rate_limit_lock:
        tokens, last_refill_time = _rate_limit_token_buckets_by_owner.get(caller["owner"], [requests_per_minute, now])
        tokens = min(requests_per_minute, tokens + (now - last_refill_time) * requests_per_minute / 60.0)
        if tokens < 1:
            raise ApiError(429, f"rate limit: {requests_per_minute} requests/minute on the {caller['plan']} plan",
                           "rate_limited")
        _rate_limit_token_buckets_by_owner[caller["owner"]] = [tokens - 1, now]


def identify_and_admit_caller(headers, client_host: str | None, should_meter_call: bool = True) -> dict:
    forwarded_ip_address = headers.get("x-forwarded-for", "").split(",")[0].strip()
    caller = identify_caller(headers.get("authorization"), forwarded_ip_address or client_host)
    consume_rate_limit_token(caller)
    if should_meter_call:
        store.record_usage(caller["owner"], call_count=1)
    return caller


def ensure_build_quota_remains(caller: dict):
    plan = store.PLANS[caller["plan"]]
    usage = store.usage_this_month(caller["owner"])
    if usage["builds"] >= plan["builds_month"]:
        raise ApiError(402, f"monthly build quota reached ({plan['builds_month']} on {caller['plan']}). "
                            "Get a free key at /v1/keys or upgrade.", "quota_exceeded")
    if usage["compute_ms"] >= plan["compute_s_month"] * 1000:
        raise ApiError(402, "monthly compute quota reached", "quota_exceeded")


def describe_plan_and_usage(caller: dict) -> dict:
    return {"owner": caller["owner"], "plan": caller["plan"], "anonymous": caller["anonymous"],
            "usage": store.usage_this_month(caller["owner"]), "limits": store.PLANS[caller["plan"]]}


@contextlib.contextmanager
def _kernel_worker_slot():
    if not _kernel_worker_slots.acquire(timeout=KERNEL_WORKER_WAIT_IN_SECONDS):
        raise ApiError(503, "all kernel workers are busy, retry shortly", "busy")
    try:
        yield
    finally:
        _kernel_worker_slots.release()


def run_in_isolated_kernel(function, *arguments, timeout_in_seconds=60.0):
    with _kernel_worker_slot():
        try:
            return kernel.run_in_forked_child(function, *arguments, timeout_in_seconds=timeout_in_seconds)
        except kernel.ScriptError as script_error:
            raise ApiError(422, str(script_error), "kernel_error")


def run_analysis_on_version(version_id: str, analysis_function, *arguments, timeout_in_seconds=60.0):
    return run_in_isolated_kernel(analysis_function, successful_version_directory(version_id), *arguments,
                                  timeout_in_seconds=timeout_in_seconds)


def build_version(caller: dict, script: str, params: dict | None = None, document_id: str | None = None,
                  parent: str | None = None, message: str | None = None, quality: str = "normal") -> dict:
    if not isinstance(script, str) or not script.strip():
        raise ApiError(400, "script is required")
    if len(script) > MAX_SCRIPT_LENGTH_IN_CHARACTERS:
        raise ApiError(413, "script too large (200 kB max)")
    ensure_build_quota_remains(caller)
    version_id = store.new_random_id_with_prefix("v")
    start_time = time.time()
    with _kernel_worker_slot():
        build_outcome = kernel.build_script(script, params or {}, store.directory_for_version(version_id),
                                            timeout_in_seconds=store.PLANS[caller["plan"]]["timeout_s"],
                                            quality=quality)
    store.record_usage(caller["owner"], build_count=1, call_count=0, compute_milliseconds=(time.time() - start_time) * 1000)
    version = store.save_version(version_id, document_id, parent, script, params, message, build_outcome, caller["owner"])
    return public_view_of_version(version)


def _public_links_for_version(version_id: str) -> dict:
    base = f"/v1/versions/{version_id}"
    return {
        "scene": f"{base}/scene", "topology": f"{base}/topology", "render": f"{base}/render.png?view=iso",
        "render_grid": f"{base}/render-grid.png", "report": f"{base}/report", "explainer": f"{base}/explainer.gif",
        "step": f"{base}/export/step", "stl": f"{base}/export/stl", "glb": f"{base}/export/glb",
        "viewer": f"/view.html?v={version_id}",
    }


def _step_with_scene_url(version_id: str, step: dict) -> dict:
    scene_url = f"/v1/versions/{version_id}/steps/{step['index']}/scene" if step.get("has_scene") else None
    return dict(step, scene_url=scene_url)


def public_view_of_version(version: dict) -> dict:
    public_fields = ("id", "document_id", "parent", "params", "message", "status", "error", "logs", "summary",
                     "param_schema", "created")
    public_view = {field: version[field] for field in public_fields}
    public_view["ok"] = version["status"] == "ok"
    public_view["script"] = version["script"]
    public_view["steps"] = [_step_with_scene_url(version["id"], step) for step in (version.get("steps") or [])]
    if public_view["ok"]:
        public_view["links"] = _public_links_for_version(version["id"])
    return public_view


def create_document(caller: dict, name: str, script: str | None, params: dict | None, is_public: bool) -> dict:
    document = store.create_document(caller["owner"], (name or "Untitled")[:200], is_public)
    version = build_version(caller, script, params, document["id"], None, "initial") if script else None
    return {"document": store.get_document(document["id"]), "version": version}


def get_visible_document_with_history(caller: dict, document_id: str) -> dict:
    document = store.get_document(document_id)
    if not document or (document["owner"] != caller["owner"] and not document["public"]):
        raise ApiError(404, "document not found")
    return {"document": document, "versions": store.list_version_history(document_id),
            "owner": document["owner"] == caller["owner"]}


def get_document_owned_by_caller(caller: dict, document_id: str) -> dict:
    document = store.get_document(document_id)
    if not document or document["owner"] != caller["owner"]:
        raise ApiError(404, "document not found (or not yours)")
    return document


def _params_merged_onto_base(base_params: dict | None, params: dict | None) -> dict | None:
    if params is None:
        return base_params
    return {**base_params, **params} if base_params else params


def build_new_document_version(caller: dict, document_id: str, script: str | None, params: dict | None,
                               parent: str | None, message: str | None) -> dict:
    document = get_document_owned_by_caller(caller, document_id)
    parent_version_id = parent or document["head"]
    base_version = store.get_version(parent_version_id) if parent_version_id else None
    if script is None and not base_version:
        raise ApiError(400, "script is required for the first version")
    if script is None:
        script, params = base_version["script"], _params_merged_onto_base(base_version["params"], params)
    return build_version(caller, script, params, document_id, parent_version_id, message)


def get_version(version_id: str) -> dict:
    version = store.get_version(version_id)
    if not version:
        raise ApiError(404, f"version {version_id} not found")
    return version


def get_successful_version(version_id: str) -> dict:
    version = get_version(version_id)
    if version["status"] != "ok":
        raise ApiError(409, f"version {version_id} failed to build: {version['error']}")
    return version


def successful_version_directory(version_id: str) -> str:
    get_successful_version(version_id)
    return store.directory_for_version(version_id)


def read_version_file_text(version_id: str, file_name: str, step_index: int | None = None) -> str:
    directory = successful_version_directory(version_id)
    if step_index is not None:
        directory = os.path.join(directory, "steps", str(int(step_index)))
    path = os.path.join(directory, file_name)
    if not os.path.exists(path):
        raise ApiError(404, "not found")
    with open(path) as version_file:
        return version_file.read()


def _filtered_topology_part(part: dict, entity_type: str | None, limit: int | None) -> dict:
    faces, edges = part["faces"], part["edges"]
    if entity_type in EDGE_GEOMETRY_TYPES:
        edges = [edge for edge in edges if edge["type"] == entity_type]
    elif entity_type:
        faces = [face for face in faces if face["type"] == entity_type]
    if limit:
        faces, edges = faces[:limit], edges[:limit]
    faces = [{key: field for key, field in face.items() if key not in ("start", "count")} for face in faces]
    return part | {"faces": faces, "edges": edges}


def filtered_topology(version_id: str, entity_type: str | None = None, limit: int | None = None) -> dict:
    topology = json.loads(read_version_file_text(version_id, "topology.json"))
    topology["parts"] = [_filtered_topology_part(part, entity_type, limit) for part in topology["parts"]]
    return topology


def _imported_version_outcome(source_path: str, extension: str, version_directory: str) -> dict:
    try:
        imported = run_in_isolated_kernel(_import_shape_file_into_directory, source_path, extension,
                                          version_directory, timeout_in_seconds=120)
        return {"ok": True, **imported}
    except ApiError as api_error:
        return {"ok": False, "error": api_error.message, "logs": ""}


def import_cad_file(caller: dict, filename: str, file_bytes: bytes, name: str | None) -> dict:
    extension = filename.rsplit(".", 1)[-1].lower()
    if extension not in IMPORTABLE_EXTENSIONS:
        raise ApiError(400, "supported imports: .step .stp .brep .stl")
    ensure_build_quota_remains(caller)
    document = store.create_document(caller["owner"], name or filename, False)
    version_id = store.new_random_id_with_prefix("v")
    version_directory = store.directory_for_version(version_id)
    os.makedirs(version_directory, exist_ok=True)
    source_path = os.path.join(version_directory, "upload." + extension)
    with open(source_path, "wb") as source_file:
        source_file.write(file_bytes)
    start_time = time.time()
    build_outcome = _imported_version_outcome(source_path, extension, version_directory)
    store.record_usage(caller["owner"], build_count=1, call_count=0, compute_milliseconds=(time.time() - start_time) * 1000)
    importer_name = "step" if extension in ("step", "stp") else extension
    script = (f"# Imported from {filename}\nfrom build123d import *\n\n"
              f"result = import_{importer_name}('{os.path.basename(source_path)}')\n")
    version = store.save_version(version_id, document["id"], None, script, {}, f"import {filename}", build_outcome,
                                 caller["owner"])
    return {"document": store.get_document(document["id"]), "version": public_view_of_version(version)}


def _import_shape_file_into_directory(source_path: str, extension: str, version_directory: str) -> dict:
    importers = {"step": bd.import_step, "stp": bd.import_step, "brep": bd.import_brep}
    shape = importers.get(extension, bd.import_stl)(source_path)
    parts = flatten_into_leaf_parts(shape, os.path.splitext(os.path.basename(source_path))[0])
    if not parts:
        raise kernel.ScriptError("no geometry found in file")
    _scene, mesh_buffers = kernel.write_meshed_parts_to_directory(parts, version_directory)
    with open(os.path.join(version_directory, "steps.json"), "w") as steps_file:
        json.dump([], steps_file)
    summary = kernel.summarize_parts_with_bounding_box(parts)
    summary["triangles"] = kernel.count_triangles(mesh_buffers)
    return {"summary": summary, "logs": "", "param_schema": [], "steps": []}
