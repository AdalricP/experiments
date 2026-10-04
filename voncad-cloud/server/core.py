"""Business logic shared by the REST API and the MCP server.

Access model: a version id is an unguessable capability (like a share link): anyone holding
it can view / render / export it. Documents are listed and modified only by their owner.
Anonymous callers get the `anon` plan, metered per IP.
"""
from __future__ import annotations

import json
import os
import threading
import time

import kernel
import store

MAX_CONCURRENT = int(os.environ.get("VONCAD_WORKERS", max(1, (os.cpu_count() or 2))))
_sem = threading.BoundedSemaphore(MAX_CONCURRENT)
_buckets: dict[str, list] = {}
_bucket_lock = threading.Lock()


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str = "error"):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code


# ------------------------------------------------------------------ identity & limits

def identify(auth: str | None, ip: str | None) -> dict:
    """-> {owner, plan, anonymous}"""
    if auth:
        key = auth.split(" ", 1)[1].strip() if auth.lower().startswith("bearer ") else auth.strip()
        row = store.lookup_key(key)
        if not row:
            raise ApiError(401, "invalid API key", "unauthorized")
        return {"owner": row["id"], "plan": row["plan"], "anonymous": False, "email": row["email"]}
    return {"owner": f"anon:{ip or 'unknown'}", "plan": "anon", "anonymous": True}


def rate_limit(who: dict):
    rpm = store.PLANS[who["plan"]]["rpm"]
    now = time.time()
    with _bucket_lock:
        tokens, last = _buckets.get(who["owner"], [rpm, now])
        tokens = min(rpm, tokens + (now - last) * rpm / 60.0)
        if tokens < 1:
            raise ApiError(429, f"rate limit: {rpm} requests/minute on the {who['plan']} plan", "rate_limited")
        _buckets[who["owner"]] = [tokens - 1, now]


def check_build_quota(who: dict):
    plan = store.PLANS[who["plan"]]
    u = store.get_usage(who["owner"])
    if u["builds"] >= plan["builds_month"]:
        raise ApiError(402, f"monthly build quota reached ({plan['builds_month']} on {who['plan']}). "
                            "Get a free key at /v1/keys or upgrade.", "quota_exceeded")
    if u["compute_ms"] >= plan["compute_s_month"] * 1000:
        raise ApiError(402, "monthly compute quota reached", "quota_exceeded")


def me(who: dict) -> dict:
    return {"owner": who["owner"], "plan": who["plan"], "anonymous": who["anonymous"],
            "usage": store.get_usage(who["owner"]), "limits": store.PLANS[who["plan"]]}


def run_kernel(fn, *args, timeout=60.0):
    if not _sem.acquire(timeout=120):
        raise ApiError(503, "all kernel workers are busy, retry shortly", "busy")
    try:
        return kernel.isolated(fn, *args, timeout=timeout)
    except kernel.ScriptError as e:
        raise ApiError(422, str(e), "kernel_error")
    finally:
        _sem.release()


# ------------------------------------------------------------------ builds & documents

def build(who: dict, script: str, params: dict | None = None, document_id: str | None = None,
          parent: str | None = None, message: str | None = None, quality: str = "normal") -> dict:
    if not isinstance(script, str) or not script.strip():
        raise ApiError(400, "script is required")
    if len(script) > 200_000:
        raise ApiError(413, "script too large (200 kB max)")
    check_build_quota(who)
    vid = store.new_id("v")
    t0 = time.time()
    timeout = store.PLANS[who["plan"]]["timeout_s"]
    if not _sem.acquire(timeout=120):
        raise ApiError(503, "all kernel workers are busy, retry shortly", "busy")
    try:
        res = kernel.build(script, params or {}, store.vdir(vid), timeout=timeout, quality=quality)
    finally:
        _sem.release()
    ms = (time.time() - t0) * 1000
    store.record_usage(who["owner"], builds=1, calls=0, compute_ms=ms)
    v = store.save_version(vid, document_id, parent, script, params, message, res, who["owner"])
    return public_version(v)


def public_version(v: dict) -> dict:
    out = {k: v[k] for k in ("id", "document_id", "parent", "params", "message", "status", "error",
                             "logs", "summary", "param_schema", "created")}
    out["ok"] = v["status"] == "ok"
    out["script"] = v["script"]
    out["steps"] = [dict(s, scene_url=f"/v1/versions/{v['id']}/steps/{s['index']}/scene" if s.get("has_scene") else None)
                    for s in (v.get("steps") or [])]
    base = f"/v1/versions/{v['id']}"
    if out["ok"]:
        out["links"] = {
            "scene": f"{base}/scene", "topology": f"{base}/topology", "render": f"{base}/render.png?view=iso",
            "render_grid": f"{base}/render-grid.png", "report": f"{base}/report", "explainer": f"{base}/explainer.gif",
            "step": f"{base}/export/step", "stl": f"{base}/export/stl", "glb": f"{base}/export/glb",
            "viewer": f"/view.html?v={v['id']}",
        }
    return out


def create_document(who: dict, name: str, script: str | None, params: dict | None, public: bool) -> dict:
    if who["anonymous"]:
        # anonymous documents are allowed but unlisted (owner is the IP bucket)
        pass
    doc = store.create_document(who["owner"], (name or "Untitled")[:200], public)
    version = build(who, script, params, doc["id"], None, "initial") if script else None
    return {"document": store.get_document(doc["id"]), "version": version}


def get_document(who: dict, did: str) -> dict:
    d = store.get_document(did)
    if not d or (d["owner"] != who["owner"] and not d["public"]):
        raise ApiError(404, "document not found")
    return {"document": d, "versions": store.list_versions(did), "owner": d["owner"] == who["owner"]}


def own_document(who: dict, did: str) -> dict:
    d = store.get_document(did)
    if not d or d["owner"] != who["owner"]:
        raise ApiError(404, "document not found (or not yours)")
    return d


def new_version(who: dict, did: str, script: str | None, params: dict | None, parent: str | None, message: str | None) -> dict:
    d = own_document(who, did)
    base = store.get_version(parent or d["head"]) if (parent or d["head"]) else None
    if script is None:
        if not base:
            raise ApiError(400, "script is required for the first version")
        script = base["script"]
        if params is None:
            params = base["params"]
        elif base["params"]:
            params = {**base["params"], **params}
    return build(who, script, params, did, parent or d["head"], message)


def version(vid: str) -> dict:
    v = store.get_version(vid)
    if not v:
        raise ApiError(404, f"version {vid} not found")
    return v


def ok_version(vid: str) -> dict:
    v = version(vid)
    if v["status"] != "ok":
        raise ApiError(409, f"version {vid} failed to build: {v['error']}")
    return v


def read_json(vid: str, name: str, step: int | None = None) -> str:
    ok_version(vid)
    d = store.vdir(vid)
    if step is not None:
        d = os.path.join(d, "steps", str(int(step)))
    p = os.path.join(d, name)
    if not os.path.exists(p):
        raise ApiError(404, "not found")
    return open(p).read()


def topology(vid: str, kind: str | None = None, limit: int | None = None) -> dict:
    t = json.loads(read_json(vid, "topology.json"))
    if kind or limit:
        for p in t["parts"]:
            if kind:
                p["faces"] = [f for f in p["faces"] if f["type"] == kind] if kind not in ("line", "circle", "bspline", "ellipse") else p["faces"]
                p["edges"] = [e for e in p["edges"] if e["type"] == kind] if kind in ("line", "circle", "bspline", "ellipse") else p["edges"]
            if limit:
                p["faces"], p["edges"] = p["faces"][:limit], p["edges"][:limit]
    for p in t["parts"]:
        for f in p["faces"]:
            f.pop("start", None)
            f.pop("count", None)
    return t


def import_file(who: dict, filename: str, data: bytes, name: str | None) -> dict:
    ext = filename.rsplit(".", 1)[-1].lower()
    if ext not in ("step", "stp", "brep", "stl"):
        raise ApiError(400, "supported imports: .step .stp .brep .stl")
    check_build_quota(who)
    doc = store.create_document(who["owner"], name or filename, False)
    vid = store.new_id("v")
    vd = store.vdir(vid)
    os.makedirs(vd, exist_ok=True)
    src = os.path.join(vd, "upload." + ext)
    with open(src, "wb") as f:
        f.write(data)
    t0 = time.time()
    try:
        res = run_kernel(_import_job, src, ext, vd, timeout=120)
        result = {"ok": True, **res}
    except ApiError as e:
        result = {"ok": False, "error": e.message, "logs": ""}
    store.record_usage(who["owner"], builds=1, calls=0, compute_ms=(time.time() - t0) * 1000)
    script = f"# Imported from {filename}\nfrom build123d import *\n\nresult = import_{'step' if ext in ('step', 'stp') else ext}('{os.path.basename(src)}')\n"
    v = store.save_version(vid, doc["id"], None, script, {}, f"import {filename}", result, who["owner"])
    return {"document": store.get_document(doc["id"]), "version": public_version(v)}


def _import_job(src, ext, vd):
    import build123d as bd
    from tessellate import flatten_parts
    if ext in ("step", "stp"):
        shp = bd.import_step(src)
    elif ext == "brep":
        shp = bd.import_brep(src)
    else:
        shp = bd.import_stl(src)
    parts = flatten_parts(shp, os.path.splitext(os.path.basename(src))[0])
    if not parts:
        raise kernel.ScriptError("no geometry found in file")
    scene, bufs = kernel.write_shape_dir(parts, vd)
    with open(os.path.join(vd, "steps.json"), "w") as f:
        json.dump([], f)
    summary = kernel.summarize(parts)
    summary["bbox"] = kernel._union_bbox(summary["parts"])
    summary["triangles"] = int(sum(len(b["indices"]) for b in bufs))
    return {"summary": summary, "logs": "", "param_schema": [], "steps": []}
