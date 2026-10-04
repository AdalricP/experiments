from __future__ import annotations

import contextlib
import json
import os
import sys
from typing import Annotated

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import Body, FastAPI, File, Form, Path, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

import agent
import analysis
import core
import examples
import explainer
import mcp_server
import render
import store
from core import ApiError

WEB_DIRECTORY = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
API_VERSION = "1.0.0"
MAX_UPLOAD_SIZE_IN_BYTES = 64 << 20
version_id_in_path = Annotated[str, Path(alias="vid")]
document_id_in_path = Annotated[str, Path(alias="did")]
IMMUTABLE_CACHE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}


@contextlib.asynccontextmanager
async def lifespan(_application):
    store.ensure_admin_api_key_from_environment()
    async with mcp_server.mcp.session_manager.run():
        yield


app = FastAPI(
    title="BISCAD API",
    version=API_VERSION,
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
async def respond_with_api_error(_request, api_error: ApiError):
    return JSONResponse({"error": {"code": api_error.code, "message": api_error.message}},
                        status_code=api_error.http_status)


def _client_host(request: Request) -> str | None:
    return request.client.host if request.client else None


def admit_caller(request: Request, should_meter_call: bool = True) -> dict:
    return core.identify_and_admit_caller(request.headers, _client_host(request), should_meter_call)


def admit_caller_to_successful_version(request: Request, version_id: str) -> dict:
    admit_caller(request)
    return core.get_successful_version(version_id)


@app.get("/v1/health")
def health():
    return {"ok": True, "version": API_VERSION, "workers": core.MAX_CONCURRENT_KERNEL_WORKERS}


@app.post("/v1/keys")
def create_key(request: Request, body: dict = Body(...)):
    email = str(body.get("email", "")).strip()
    if "@" not in email or len(email) > 200:
        raise ApiError(400, "a valid email is required")
    core.consume_rate_limit_token(core.identify_caller(None, _client_host(request)))
    return store.create_api_key(email)


@app.get("/v1/me")
def get_me(request: Request):
    return core.describe_plan_and_usage(admit_caller(request, should_meter_call=False))


@app.get("/v1/examples")
def get_examples():
    return {"examples": examples.EXAMPLES}


@app.post("/v1/build")
def build(request: Request, body: dict = Body(...)):
    caller = admit_caller(request)
    version = core.build_version(caller, body.get("script"), body.get("params"), quality=str(body.get("quality", "normal")))
    if version["ok"] and body.get("include_scene", True):
        version["scene"] = json.loads(core.read_version_file_text(version["id"], "scene.json"))
    return version


@app.post("/v1/documents")
def create_document(request: Request, body: dict = Body(...)):
    caller = admit_caller(request)
    return core.create_document(caller, body.get("name"), body.get("script"), body.get("params"),
                                bool(body.get("public", False)))


@app.get("/v1/documents")
def list_documents(request: Request):
    return {"documents": store.list_documents(admit_caller(request)["owner"])}


@app.get("/v1/documents/{did}")
def get_document(request: Request, document_id: document_id_in_path):
    return core.get_visible_document_with_history(admit_caller(request), document_id)


@app.patch("/v1/documents/{did}")
def patch_document(request: Request, document_id: document_id_in_path, body: dict = Body(...)):
    caller = admit_caller(request)
    core.get_document_owned_by_caller(caller, document_id)
    store.update_document_name_and_visibility(document_id, body.get("name"), body.get("public"))
    return core.get_visible_document_with_history(caller, document_id)


@app.delete("/v1/documents/{did}")
def delete_document(request: Request, document_id: document_id_in_path):
    core.get_document_owned_by_caller(admit_caller(request), document_id)
    store.delete_document_and_its_versions(document_id)
    return {"deleted": document_id}


@app.post("/v1/documents/{did}/versions")
def new_version(request: Request, document_id: document_id_in_path, body: dict = Body(...)):
    caller = admit_caller(request)
    return {"version": core.build_new_document_version(caller, document_id, body.get("script"), body.get("params"),
                                                       body.get("parent"), body.get("message"))}


@app.post("/v1/import")
async def import_file(request: Request, file: UploadFile = File(...), name: str | None = Form(None)):
    caller = admit_caller(request)
    file_bytes = await file.read()
    if len(file_bytes) > MAX_UPLOAD_SIZE_IN_BYTES:
        raise ApiError(413, "file too large (64 MB max)")
    return await run_in_threadpool(core.import_cad_file, caller, file.filename or "upload.step", file_bytes, name)


@app.get("/v1/versions/{vid}")
def get_version(request: Request, version_id: version_id_in_path):
    admit_caller(request)
    return core.public_view_of_version(core.get_version(version_id))


@app.get("/v1/versions/{vid}/scene")
def get_scene(request: Request, version_id: version_id_in_path):
    admit_caller(request)
    return Response(core.read_version_file_text(version_id, "scene.json"), media_type="application/json",
                    headers=IMMUTABLE_CACHE_HEADERS)


@app.get("/v1/versions/{vid}/topology")
def get_topology(request: Request, version_id: version_id_in_path,
                 entity_type: str | None = Query(None, alias="type"), limit: int | None = None):
    admit_caller(request)
    return core.filtered_topology(version_id, entity_type, limit)


@app.get("/v1/versions/{vid}/steps")
def get_steps(request: Request, version_id: version_id_in_path):
    return {"steps": core.public_view_of_version(admit_caller_to_successful_version(request, version_id))["steps"]}


@app.get("/v1/versions/{vid}/steps/{idx}/scene")
def get_step_scene(request: Request, version_id: version_id_in_path, step_index: Annotated[int, Path(alias="idx")]):
    admit_caller(request)
    return Response(core.read_version_file_text(version_id, "scene.json", step_index=step_index), media_type="application/json",
                    headers=IMMUTABLE_CACHE_HEADERS)


def _parse_view_argument(view: str):
    if "," in view:
        try:
            return tuple(float(component) for component in view.split(","))
        except ValueError:
            raise ApiError(400, "view must be a name or 'x,y,z'")
    if view not in render.VIEW_DIRECTIONS:
        raise ApiError(400, f"view must be one of {', '.join(render.VIEW_DIRECTIONS)} or 'x,y,z'")
    return view


def _comma_separated_ids(text: str) -> list[str]:
    return [entity_id for entity_id in text.split(",") if entity_id]


@app.get("/v1/versions/{vid}/render.png")
def render_png(request: Request, version_id: version_id_in_path, view: str = "iso",
               width_in_pixels: int = Query(800, alias="w", le=2000, ge=64),
               height_in_pixels: int = Query(600, alias="h", le=2000, ge=64), highlight: str = "", labels: bool = False,
               edges: bool = True, hide: str = "", theme: str = Query("light", pattern="^(light|dark)$")):
    admit_caller_to_successful_version(request, version_id)
    background_for_theme = {"light": "#ffffff", "dark": "#161011"}[theme]
    png_bytes = render.render_version_png(store.directory_for_version(version_id), _parse_view_argument(view),
                                          width_in_pixels, height_in_pixels,
                                          highlight=_comma_separated_ids(highlight), labels=labels, edges=edges,
                                          hidden=_comma_separated_ids(hide), background=background_for_theme)
    return Response(png_bytes, media_type="image/png")


@app.get("/v1/versions/{vid}/render-grid.png")
def render_grid(request: Request, version_id: version_id_in_path, size: int = Query(420, le=1000, ge=128),
                labels: bool = False):
    admit_caller_to_successful_version(request, version_id)
    return Response(render.render_four_view_grid_png(store.directory_for_version(version_id), size, labels), media_type="image/png")


def _download_name_for_version(version: dict) -> str:
    document = store.get_document(version["document_id"]) if version.get("document_id") else None
    if not document:
        return "model"
    return "".join(character if character.isalnum() or character in "-_" else "-"
                   for character in document["name"])[:60] or "model"


@app.get("/v1/versions/{vid}/export/{fmt}")
def export(request: Request, version_id: version_id_in_path, export_format: Annotated[str, Path(alias="fmt")]):
    admit_caller(request)
    format_name = export_format.lower()
    if format_name not in analysis.EXPORT_FORMATS:
        raise ApiError(400, f"format must be one of {', '.join(analysis.EXPORT_FORMATS)}")
    version = core.get_successful_version(version_id)
    export_path = core.run_in_isolated_kernel(analysis.export_version, store.directory_for_version(version_id), format_name,
                                              timeout_in_seconds=120)
    export_file_name, media_type = analysis.EXPORT_FORMATS[format_name]
    extension = export_file_name.rsplit(".", 1)[1]
    return FileResponse(export_path, media_type=media_type,
                        filename=f"{_download_name_for_version(version)}-{version_id[-6:]}.{extension}")


@app.post("/v1/versions/{vid}/measure")
def measure(request: Request, version_id: version_id_in_path, body: dict = Body(...)):
    admit_caller_to_successful_version(request, version_id)
    if not body.get("a"):
        raise ApiError(400, "a is required (e.g. 'p0/f3')")
    return core.run_analysis_on_version(version_id, analysis.measure_references, body["a"], body.get("b"))


@app.post("/v1/versions/{vid}/section")
def section(request: Request, version_id: version_id_in_path, body: dict = Body(...)):
    admit_caller(request)
    return core.run_analysis_on_version(version_id, analysis.section_with_plane, body.get("origin", [0, 0, 0]),
                                        body.get("normal", [0, 0, 1]))


@app.get("/v1/versions/{vid}/mass")
def mass(request: Request, version_id: version_id_in_path, density: float = Query(7.85, gt=0, lt=100)):
    admit_caller(request)
    return core.run_analysis_on_version(version_id, analysis.mass_properties, density)


@app.post("/v1/versions/{vid}/check")
def check(request: Request, version_id: version_id_in_path, body: dict = Body(default={})):
    admit_caller_to_successful_version(request, version_id)
    process = (body or {}).get("process", "fdm")
    if process not in analysis.BUILD_ENVELOPES_IN_MILLIMETERS:
        raise ApiError(400, "process must be fdm, cnc or sheet")
    return core.run_analysis_on_version(version_id, analysis.check_manufacturability, process)


@app.get("/v1/versions/{vid}/interference")
def interference(request: Request, version_id: version_id_in_path):
    admit_caller(request)
    return core.run_analysis_on_version(version_id, analysis.detect_interference, timeout_in_seconds=120)


@app.get("/v1/versions/{vid}/bom")
def bom(request: Request, version_id: version_id_in_path, density: float | None = Query(None, gt=0, lt=100)):
    admit_caller(request)
    return core.run_analysis_on_version(version_id, analysis.bill_of_materials, density)


@app.get("/v1/diff")
def diff(request: Request, first_version_id: str = Query(alias="a"), second_version_id: str = Query(alias="b")):
    admit_caller(request)
    return core.run_in_isolated_kernel(analysis.diff_versions, core.successful_version_directory(first_version_id),
                                       core.successful_version_directory(second_version_id))


def _cached_version_file(version_directory: str, file_name: str, produce_content, write_mode: str) -> str:
    cached_path = os.path.join(version_directory, file_name)
    if os.path.exists(cached_path):
        return cached_path
    content = produce_content()
    with open(cached_path + ".tmp", write_mode) as cache_file:
        cache_file.write(content)
    os.replace(cached_path + ".tmp", cached_path)
    return cached_path


@app.get("/v1/versions/{vid}/explainer.gif")
def explainer_gif(request: Request, version_id: version_id_in_path):
    admit_caller_to_successful_version(request, version_id)
    version_directory = store.directory_for_version(version_id)
    gif_path = _cached_version_file(version_directory, "explainer.gif",
                                    lambda: explainer.build_explainer_gif(version_directory), "wb")
    return FileResponse(gif_path, media_type="image/gif")


def _design_report_html(version: dict, version_directory: str) -> str:
    manufacturability = core.run_in_isolated_kernel(analysis.check_manufacturability, version_directory, "fdm")
    document = store.get_document(version["document_id"]) if version.get("document_id") else None
    return explainer.build_design_report_html(version_directory, core.public_view_of_version(version), document,
                                              manufacturability)


@app.get("/v1/versions/{vid}/report", response_class=HTMLResponse)
def report(request: Request, version_id: version_id_in_path):
    version = admit_caller_to_successful_version(request, version_id)
    version_directory = store.directory_for_version(version_id)
    report_path = _cached_version_file(version_directory, "report.html",
                                       lambda: _design_report_html(version, version_directory), "w")
    return FileResponse(report_path, media_type="text/html")


@app.get("/v1/agent")
def agent_status():
    return {"available": agent.is_available(), "model": agent.MODEL, "max_rounds": agent.MAX_ROUNDS}


def _ensure_agent_quota_remains(caller: dict):
    monthly_agent_runs = store.PLANS[caller["plan"]]["agent_runs_month"]
    if store.usage_this_month("agent:" + caller["owner"])["builds"] >= monthly_agent_runs:
        raise ApiError(402, f"monthly text-to-CAD quota reached ({monthly_agent_runs} on {caller['plan']})",
                       "quota_exceeded")


@app.post("/v1/agent")
def agent_run(request: Request, body: dict = Body(...)):
    """Text-to-CAD. {prompt, script?, document_id?} -> {ok, version, rounds}"""
    caller = admit_caller(request)
    if caller["anonymous"]:
        raise ApiError(401, "text-to-CAD needs an API key (free at POST /v1/keys)", "unauthorized")
    _ensure_agent_quota_remains(caller)
    if body.get("document_id"):
        core.get_document_owned_by_caller(caller, body["document_id"])
    store.record_usage("agent:" + caller["owner"], build_count=1, call_count=0)
    return agent.run_text_to_cad(caller, str(body.get("prompt", "")), body.get("script"), body.get("document_id"))


@app.get("/llms.txt", response_class=PlainTextResponse)
def llms():
    llms_path = os.path.join(WEB_DIRECTORY, "llms.txt")
    if not os.path.exists(llms_path):
        return "BISCAD. See /docs and /mcp."
    with open(llms_path) as llms_file:
        return llms_file.read()


app.router.routes.extend(mcp_server.mcp.streamable_http_app().routes)

if os.path.isdir(WEB_DIRECTORY):
    app.mount("/", StaticFiles(directory=WEB_DIRECTORY, html=True), name="web")
