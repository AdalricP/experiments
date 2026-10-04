"""BISCAD — REST API + MCP server + static site.

    uvicorn app:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import contextlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build123d  # noqa: F401  - preload the kernel so forked workers start warm

from fastapi import Body, FastAPI, File, Form, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

import analysis
import core
import examples
import explainer
import render as R
import store
from core import ApiError

WEB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
VERSION = "1.0.0"

import mcp_server  # noqa: E402

mcp_app = mcp_server.mcp.streamable_http_app()


@contextlib.asynccontextmanager
async def lifespan(app):
    store.ensure_admin_key()
    async with mcp_server.mcp.session_manager.run():
        yield


app = FastAPI(
    title="BISCAD API",
    version=VERSION,
    description="AI-native CAD kernel: build123d / OpenCascade as an API. "
                "Build parametric B-rep models from Python, get stable face/edge references, "
                "renders agents can see, exports (STEP/STL/GLB/3MF/SVG/DXF), analysis, and an MCP server at /mcp.",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["Content-Disposition"])


@app.exception_handler(ApiError)
async def api_error(_req, e: ApiError):
    return JSONResponse({"error": {"code": e.code, "message": e.message}}, status_code=e.status)


def who(req: Request, metered=True) -> dict:
    ip = req.headers.get("x-forwarded-for", "").split(",")[0].strip() or (req.client.host if req.client else None)
    w = core.identify(req.headers.get("authorization"), ip)
    core.rate_limit(w)
    if metered:
        store.record_usage(w["owner"], calls=1)
    return w


# ------------------------------------------------------------------ meta

@app.get("/v1/health")
def health():
    return {"ok": True, "version": VERSION, "workers": core.MAX_CONCURRENT}


@app.post("/v1/keys")
def create_key(req: Request, body: dict = Body(...)):
    email = str(body.get("email", "")).strip()
    if "@" not in email or len(email) > 200:
        raise ApiError(400, "a valid email is required")
    core.rate_limit(core.identify(None, req.client.host if req.client else None))
    return store.create_key(email)


@app.get("/v1/me")
def get_me(req: Request):
    return core.me(who(req, metered=False))


@app.get("/v1/examples")
def get_examples():
    return {"examples": examples.EXAMPLES}


# ------------------------------------------------------------------ builds

@app.post("/v1/build")
def build(req: Request, body: dict = Body(...)):
    w = who(req)
    v = core.build(w, body.get("script"), body.get("params"), quality=str(body.get("quality", "normal")))
    if v["ok"] and body.get("include_scene", True):
        v["scene"] = json.loads(core.read_json(v["id"], "scene.json"))
    return v


@app.post("/v1/documents")
def create_document(req: Request, body: dict = Body(...)):
    w = who(req)
    return core.create_document(w, body.get("name"), body.get("script"), body.get("params"), bool(body.get("public", False)))


@app.get("/v1/documents")
def list_documents(req: Request):
    return {"documents": store.list_documents(who(req)["owner"])}


@app.get("/v1/documents/{did}")
def get_document(req: Request, did: str):
    return core.get_document(who(req), did)


@app.patch("/v1/documents/{did}")
def patch_document(req: Request, did: str, body: dict = Body(...)):
    w = who(req)
    core.own_document(w, did)
    store.rename_document(did, body.get("name"), body.get("public"))
    return core.get_document(w, did)


@app.delete("/v1/documents/{did}")
def delete_document(req: Request, did: str):
    w = who(req)
    core.own_document(w, did)
    store.delete_document(did)
    return {"deleted": did}


@app.post("/v1/documents/{did}/versions")
def new_version(req: Request, did: str, body: dict = Body(...)):
    w = who(req)
    return {"version": core.new_version(w, did, body.get("script"), body.get("params"), body.get("parent"), body.get("message"))}


@app.post("/v1/import")
async def import_file(req: Request, file: UploadFile = File(...), name: str | None = Form(None)):
    w = who(req)
    data = await file.read()
    if len(data) > 64 << 20:
        raise ApiError(413, "file too large (64 MB max)")
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(core.import_file, w, file.filename or "upload.step", data, name)


# ------------------------------------------------------------------ versions

@app.get("/v1/versions/{vid}")
def get_version(req: Request, vid: str):
    who(req)
    return core.public_version(core.version(vid))


@app.get("/v1/versions/{vid}/scene")
def get_scene(req: Request, vid: str):
    who(req)
    return Response(core.read_json(vid, "scene.json"), media_type="application/json",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/v1/versions/{vid}/topology")
def get_topology(req: Request, vid: str, type: str | None = None, limit: int | None = None):
    who(req)
    return core.topology(vid, type, limit)


@app.get("/v1/versions/{vid}/steps")
def get_steps(req: Request, vid: str):
    who(req)
    return {"steps": core.public_version(core.ok_version(vid))["steps"]}


@app.get("/v1/versions/{vid}/steps/{idx}/scene")
def get_step_scene(req: Request, vid: str, idx: int):
    who(req)
    return Response(core.read_json(vid, "scene.json", step=idx), media_type="application/json",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


def _views_arg(view: str):
    if "," in view:
        try:
            return tuple(float(x) for x in view.split(","))
        except ValueError:
            raise ApiError(400, "view must be a name or 'x,y,z'")
    if view not in R.VIEWS:
        raise ApiError(400, f"view must be one of {', '.join(R.VIEWS)} or 'x,y,z'")
    return view


@app.get("/v1/versions/{vid}/render.png")
def render_png(req: Request, vid: str, view: str = "iso", w: int = Query(800, le=2000, ge=64),
               h: int = Query(600, le=2000, ge=64), highlight: str = "", labels: bool = False,
               edges: bool = True, hide: str = ""):
    who(req)
    core.ok_version(vid)
    png = R.render(store.vdir(vid), _views_arg(view), w, h,
                   highlight=[x for x in highlight.split(",") if x], labels=labels, edges=edges,
                   hidden=[x for x in hide.split(",") if x])
    return Response(png, media_type="image/png")


@app.get("/v1/versions/{vid}/render-grid.png")
def render_grid(req: Request, vid: str, size: int = Query(420, le=1000, ge=128), labels: bool = False):
    who(req)
    core.ok_version(vid)
    return Response(R.render_grid(store.vdir(vid), size, labels), media_type="image/png")


@app.get("/v1/versions/{vid}/export/{fmt}")
def export(req: Request, vid: str, fmt: str):
    who(req)
    fmt = fmt.lower()
    if fmt not in analysis.EXPORT_TYPES:
        raise ApiError(400, f"format must be one of {', '.join(analysis.EXPORT_TYPES)}")
    v = core.ok_version(vid)
    path = core.run_kernel(analysis.export, store.vdir(vid), fmt, timeout=120)
    name = "model"
    if v.get("document_id"):
        d = store.get_document(v["document_id"])
        if d:
            name = "".join(c if c.isalnum() or c in "-_" else "-" for c in d["name"])[:60] or "model"
    fname = analysis.EXPORT_TYPES[fmt][0]
    ext = fname.rsplit(".", 1)[1]
    return FileResponse(path, media_type=analysis.EXPORT_TYPES[fmt][1], filename=f"{name}-{vid[-6:]}.{ext}")


@app.post("/v1/versions/{vid}/measure")
def measure(req: Request, vid: str, body: dict = Body(...)):
    who(req)
    core.ok_version(vid)
    if not body.get("a"):
        raise ApiError(400, "a is required (e.g. 'p0/f3')")
    return core.run_kernel(analysis.measure, store.vdir(vid), body["a"], body.get("b"))


@app.post("/v1/versions/{vid}/section")
def section(req: Request, vid: str, body: dict = Body(...)):
    who(req)
    core.ok_version(vid)
    return core.run_kernel(analysis.section, store.vdir(vid), body.get("origin", [0, 0, 0]), body.get("normal", [0, 0, 1]))


@app.get("/v1/versions/{vid}/mass")
def mass(req: Request, vid: str, density: float = Query(7.85, gt=0, lt=100)):
    who(req)
    core.ok_version(vid)
    return core.run_kernel(analysis.mass, store.vdir(vid), density)


@app.post("/v1/versions/{vid}/check")
def check(req: Request, vid: str, body: dict = Body(default={})):
    who(req)
    core.ok_version(vid)
    process = (body or {}).get("process", "fdm")
    if process not in analysis.BUILD_VOLUMES:
        raise ApiError(400, "process must be fdm, cnc or sheet")
    return core.run_kernel(analysis.check, store.vdir(vid), process)


@app.get("/v1/versions/{vid}/interference")
def interference(req: Request, vid: str):
    who(req)
    core.ok_version(vid)
    return core.run_kernel(analysis.interference, store.vdir(vid), timeout=120)


@app.get("/v1/versions/{vid}/bom")
def bom(req: Request, vid: str, density: float | None = Query(None, gt=0, lt=100)):
    who(req)
    core.ok_version(vid)
    return core.run_kernel(analysis.bom, store.vdir(vid), density)


@app.get("/v1/diff")
def diff(req: Request, a: str, b: str):
    who(req)
    core.ok_version(a)
    core.ok_version(b)
    return core.run_kernel(analysis.diff, store.vdir(a), store.vdir(b))


@app.get("/v1/versions/{vid}/explainer.gif")
def explainer_gif(req: Request, vid: str):
    who(req)
    core.ok_version(vid)
    path = os.path.join(store.vdir(vid), "explainer.gif")
    if not os.path.exists(path):
        data = explainer.explainer_gif(store.vdir(vid))
        with open(path + ".tmp", "wb") as f:
            f.write(data)
        os.replace(path + ".tmp", path)
    return FileResponse(path, media_type="image/gif")


@app.get("/v1/versions/{vid}/report", response_class=HTMLResponse)
def report(req: Request, vid: str):
    who(req)
    v = core.ok_version(vid)
    path = os.path.join(store.vdir(vid), "report.html")
    if not os.path.exists(path):
        dfm = core.run_kernel(analysis.check, store.vdir(vid), "fdm")
        doc = store.get_document(v["document_id"]) if v.get("document_id") else None
        html = explainer.report_html(store.vdir(vid), core.public_version(v), doc, {}, dfm)
        with open(path, "w") as f:
            f.write(html)
    return FileResponse(path, media_type="text/html")


# ------------------------------------------------------------------ agents

@app.get("/v1/agent")
def agent_status():
    import agent
    return {"available": agent.available(), "model": agent.MODEL, "max_rounds": agent.MAX_ROUNDS}


@app.post("/v1/agent")
def agent_run(req: Request, body: dict = Body(...)):
    """Text-to-CAD. {prompt, script?, document_id?} -> {ok, version, rounds}"""
    import agent
    w = who(req)
    if w["anonymous"]:
        raise ApiError(401, "text-to-CAD needs an API key (free at POST /v1/keys)", "unauthorized")
    cap = store.PLANS[w["plan"]]["agent_runs_month"]
    used = store.get_usage("agent:" + w["owner"])["builds"]
    if used >= cap:
        raise ApiError(402, f"monthly text-to-CAD quota reached ({cap} on {w['plan']})", "quota_exceeded")
    if body.get("document_id"):
        core.own_document(w, body["document_id"])
    store.record_usage("agent:" + w["owner"], builds=1, calls=0)
    return agent.run(w, str(body.get("prompt", "")), body.get("script"), body.get("document_id"))


@app.get("/llms.txt", response_class=PlainTextResponse)
def llms():
    p = os.path.join(WEB, "llms.txt")
    return open(p).read() if os.path.exists(p) else "BISCAD. See /docs and /mcp."


# MCP: merge its routes (path /mcp) instead of mounting, so /mcp works without a trailing slash
app.router.routes.extend(mcp_app.routes)

if os.path.isdir(WEB):
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
