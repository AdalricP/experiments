"""MCP server: the same kernel, as tools an agent can call. Mounted at /mcp (streamable HTTP).

Renders come back as real images, so a multimodal agent sees what it built.
"""
from __future__ import annotations

import json

from mcp.server.fastmcp import Context, FastMCP, Image
from mcp.server.transport_security import TransportSecuritySettings

import analysis
import core
import examples
import render as R
import store

GUIDE = """BISCAD builds CAD models from build123d (Python) programs on an OpenCascade B-rep kernel.

Workflow: build_model (or create_document + update_document for versioned work) -> look at the returned
render -> get_topology to find face/edge ids -> measure / section / check_manufacturability -> export_model.

Script rules:
- `from build123d import *`. Allowed imports: build123d, math, numpy, random, itertools, functools,
  collections, typing, dataclasses, enum, copy, statistics, fractions, decimal, string, re.
- Put the final shape in `result` (a Part, Compound, list or dict of shapes) or call `show(shape, ...)`.
- Declare tunable values as a literal dict at top level: `params = {"width": 40, "hole": 6.5}`;
  callers can override them per build (configurations). Units are millimetres, Z is up.
- Assemblies: give children `.label` and `.color = Color(r, g, b)` and return
  `Compound(children=[...])`.
- No file, network or OS access. Builds time out (30-180 s by plan).

References: faces/edges/vertices are named `p<part>/f<n>`, `p<part>/e<n>`, `p<part>/v<n>`; n is the
index in build123d's `part.faces()` / `part.edges()` order, so `p0/f3` is `result.faces()[3]` for a
single part. Ids are stable for the same program and parameters.

build123d cheatsheet:
  with BuildPart() as p:
      Box(40, 30, 10)                                   # centred on origin
      Cylinder(5, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
      with BuildSketch(Plane.XY.offset(10)): Circle(8); Rectangle(20, 4, mode=Mode.SUBTRACT)
      extrude(amount=5)                                 # or mode=Mode.SUBTRACT to cut
      fillet(p.edges().filter_by(Axis.Z), radius=2)
      chamfer(p.edges().group_by(Axis.Z)[-1], length=1)
      with Locations((10, 0, 10)): Hole(3)              # holes drill down -Z of the workplane
      with PolarLocations(12, 6): Hole(1.5)
      with GridLocations(20, 20, 2, 2): CounterBoreHole(2, 3.5, 2)
      offset(amount=-2, openings=p.faces().sort_by(Axis.Z)[-1])   # shell
  result = p.part
Selectors: .faces()/.edges()/.vertices(), .filter_by(Axis.Z | GeomType.CIRCLE), .sort_by(Axis.Z),
.group_by(Axis.Z)[-1], .sort_by_distance((x, y, z)). Algebra mode also works: `result = Box(10,10,10) - Cylinder(3, 10)`.
"""

mcp = FastMCP(
    "biscad",
    instructions=GUIDE,
    stateless_http=True,
    json_response=True,
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


def _who(ctx: Context) -> dict:
    req = None
    try:
        req = ctx.request_context.request
    except Exception:
        pass
    headers = getattr(req, "headers", {}) or {}
    ip = None
    if req is not None:
        ip = (headers.get("x-forwarded-for", "").split(",")[0].strip()
              or (req.client.host if getattr(req, "client", None) else None))
    w = core.identify(headers.get("authorization"), ip)
    core.rate_limit(w)
    store.record_usage(w["owner"], calls=1)
    return w


def _base(ctx: Context) -> str:
    try:
        req = ctx.request_context.request
        proto = req.headers.get("x-forwarded-proto", req.url.scheme)
        host = req.headers.get("x-forwarded-host", req.headers.get("host"))
        return f"{proto}://{host}"
    except Exception:
        return ""


def _err(e: core.ApiError) -> str:
    return json.dumps({"error": e.code, "message": e.message})


def _brief(v: dict, base: str) -> dict:
    out = {"version_id": v["id"], "ok": v["ok"], "document_id": v.get("document_id")}
    if not v["ok"]:
        out["error"] = v["error"]
        out["hint"] = "Fix the script and build again. Logs: " + (v.get("logs") or "")[-1500:]
        return out
    s = v["summary"]
    out["summary"] = {
        "bbox": s["bbox"], "volume_mm3": s["volume"], "area_mm2": s["area"], "center_of_mass": s["center_of_mass"],
        "mass_g": {"steel": s["mass_g_steel"], "aluminium": s["mass_g_aluminium"], "pla": s["mass_g_pla"]},
        "parts": [{k: p[k] for k in ("id", "name", "volume", "faces", "edges", "solids", "valid")} | {"size": p["bbox"]["size"]}
                  for p in s["parts"]],
        "build_ms": s.get("timing_ms", {}).get("total"),
    }
    out["param_schema"] = v["param_schema"]
    out["steps"] = [f"{st['index'] + 1}. {st['description']}" for st in v["steps"]]
    out["viewer_url"] = f"{base}/view.html?v={v['id']}"
    out["report_url"] = f"{base}/v1/versions/{v['id']}/report"
    if v.get("logs"):
        out["stdout"] = v["logs"][-2000:]
    return out


def _img(vid: str, view="iso", labels=True, highlight=(), w=720, h=540) -> Image:
    png = R.render(store.vdir(vid), view, w, h, labels=labels, highlight=list(highlight))
    return Image(data=png, format="png")


@mcp.tool()
def build_model(script: str, ctx: Context, params: dict | None = None, render: bool = True) -> list:
    """Build a build123d program. Returns a summary (bbox, volume, mass, parts, build steps, param
    schema, viewer URL) and an iso render with face ids labelled. Not saved to a document; use
    create_document for versioned work. The returned version_id works with every other tool."""
    try:
        w = _who(ctx)
        v = core.build(w, script, params)
    except core.ApiError as e:
        return [_err(e)]
    out = [json.dumps(_brief(v, _base(ctx)), separators=(",", ":"))]
    if v["ok"] and render:
        out.append(_img(v["id"]))
    return out


@mcp.tool()
def create_document(name: str, script: str, ctx: Context, params: dict | None = None, public: bool = False) -> list:
    """Create a versioned document from a build123d program and build its first version."""
    try:
        w = _who(ctx)
        r = core.create_document(w, name, script, params, public)
    except core.ApiError as e:
        return [_err(e)]
    v = r["version"]
    out = [json.dumps({"document_id": r["document"]["id"], **_brief(v, _base(ctx))}, separators=(",", ":"))]
    if v["ok"]:
        out.append(_img(v["id"]))
    return out


@mcp.tool()
def update_document(document_id: str, ctx: Context, script: str | None = None, params: dict | None = None,
                    message: str | None = None, parent_version_id: str | None = None) -> list:
    """Add a new version to a document: a new script and/or parameter overrides (omitted script reuses
    the parent's). Parent defaults to the document head. Returns summary + render."""
    try:
        w = _who(ctx)
        v = core.new_version(w, document_id, script, params, parent_version_id, message)
    except core.ApiError as e:
        return [_err(e)]
    out = [json.dumps(_brief(v, _base(ctx)), separators=(",", ":"))]
    if v["ok"]:
        out.append(_img(v["id"]))
    return out


@mcp.tool()
def list_documents(ctx: Context) -> str:
    """List your documents (most recently updated first)."""
    try:
        w = _who(ctx)
    except core.ApiError as e:
        return _err(e)
    return json.dumps([{k: d[k] for k in ("id", "name", "head", "updated", "public")} for d in store.list_documents(w["owner"])])


@mcp.tool()
def get_document(document_id: str, ctx: Context) -> str:
    """A document and its version history."""
    try:
        return json.dumps(core.get_document(_who(ctx), document_id), separators=(",", ":"))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def get_script(version_id: str, ctx: Context) -> str:
    """The build123d source and parameters of a version (to edit and rebuild)."""
    try:
        _who(ctx)
        v = core.version(version_id)
    except core.ApiError as e:
        return _err(e)
    return json.dumps({"script": v["script"], "params": v["params"], "param_schema": v["param_schema"]}, separators=(",", ":"))


@mcp.tool()
def get_topology(version_id: str, ctx: Context, type: str | None = None, limit: int | None = 200) -> str:
    """Faces and edges with stable ids (p0/f3, p0/e7), type (plane, cylinder, line, circle...), area or
    length, centre, normal, radius, axis. Filter with type, e.g. 'cylinder' or 'circle'."""
    try:
        _who(ctx)
        return json.dumps(core.topology(version_id, type, limit))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def render_view(version_id: str, ctx: Context, view: str = "iso", labels: bool = True,
                highlight: list[str] | None = None) -> list:
    """Render a version to an image. view: iso, iso2, iso_back, iso_below, front, back, left, right,
    top, bottom. labels draws face ids; highlight paints the given ids (e.g. ['p0/f3']) orange."""
    try:
        _who(ctx)
        core.ok_version(version_id)
    except core.ApiError as e:
        return [_err(e)]
    if view not in R.VIEWS:
        return [_err(core.ApiError(400, f"view must be one of {', '.join(R.VIEWS)}"))]
    return [_img(version_id, view, labels, highlight or ())]


@mcp.tool()
def render_grid(version_id: str, ctx: Context, labels: bool = False) -> list:
    """Iso, front, top and right views in one image: the fastest way to check a model."""
    try:
        _who(ctx)
        core.ok_version(version_id)
    except core.ApiError as e:
        return [_err(e)]
    return [Image(data=R.render_grid(store.vdir(version_id), 400, labels), format="png")]


@mcp.tool()
def get_build_steps(version_id: str, ctx: Context) -> str:
    """How the model was built: one entry per operation, with a plain-English description, the
    script line, and volume/face counts after the step."""
    try:
        _who(ctx)
        v = core.public_version(core.ok_version(version_id))
    except core.ApiError as e:
        return _err(e)
    return json.dumps([{k: s[k] for k in ("index", "op", "line", "description", "volume", "faces")} for s in v["steps"]], separators=(",", ":"))


@mcp.tool()
def measure(version_id: str, a: str, ctx: Context, b: str | None = None) -> str:
    """Measure one entity (properties) or two (min distance, closest points, angle, parallel /
    perpendicular). Refs like 'p0/f3', 'p0/e7', 'p0/v2' or a whole part 'p1'."""
    try:
        _who(ctx)
        core.ok_version(version_id)
        return json.dumps(core.run_kernel(analysis.measure, store.vdir(version_id), a, b))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def section(version_id: str, ctx: Context, origin: list[float] = [0, 0, 0], normal: list[float] = [0, 0, 1]) -> str:
    """Cut the model with a plane. Returns the cut area (mm²), number of regions, and an SVG of the section."""
    try:
        _who(ctx)
        core.ok_version(version_id)
        return json.dumps(core.run_kernel(analysis.section, store.vdir(version_id), origin, normal))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def mass_properties(version_id: str, ctx: Context, density_g_cm3: float = 7.85) -> str:
    """Mass, centre of mass and inertia tensor per part for a density (steel 7.85, aluminium 2.70,
    PLA 1.24, ABS 1.04, titanium 4.43)."""
    try:
        _who(ctx)
        core.ok_version(version_id)
        return json.dumps(core.run_kernel(analysis.mass, store.vdir(version_id), density_g_cm3))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def check_manufacturability(version_id: str, ctx: Context, process: str = "fdm") -> str:
    """DFM checks for 'fdm', 'cnc' or 'sheet': build envelope, validity, disconnected solids, tiny
    edges, overhangs, small radii, estimated minimum wall. Issues carry face/edge refs."""
    try:
        _who(ctx)
        core.ok_version(version_id)
        return json.dumps(core.run_kernel(analysis.check, store.vdir(version_id), process))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def check_interference(version_id: str, ctx: Context) -> str:
    """Clash detection for assemblies: which parts overlap, by how much volume, and where."""
    try:
        _who(ctx)
        core.ok_version(version_id)
        return json.dumps(core.run_kernel(analysis.interference, store.vdir(version_id), timeout=120))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def bill_of_materials(version_id: str, ctx: Context, density_g_cm3: float | None = None) -> str:
    """BOM: identical parts grouped with quantities, sizes and (optionally) mass."""
    try:
        _who(ctx)
        core.ok_version(version_id)
        return json.dumps(core.run_kernel(analysis.bom, store.vdir(version_id), density_g_cm3))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def diff_versions(version_a: str, version_b: str, ctx: Context) -> str:
    """Geometric diff between two versions: volume added/removed, faces added/removed, bbox change."""
    try:
        _who(ctx)
        core.ok_version(version_a)
        core.ok_version(version_b)
        return json.dumps(core.run_kernel(analysis.diff, store.vdir(version_a), store.vdir(version_b)))
    except core.ApiError as e:
        return _err(e)


@mcp.tool()
def export_model(version_id: str, ctx: Context, format: str = "step") -> str:
    """Get a download URL for step, stl, glb, 3mf, brep, obj, svg (3-view drawing) or dxf."""
    try:
        _who(ctx)
        core.ok_version(version_id)
    except core.ApiError as e:
        return _err(e)
    if format not in analysis.EXPORT_TYPES:
        return _err(core.ApiError(400, f"format must be one of {', '.join(analysis.EXPORT_TYPES)}"))
    return json.dumps({"url": f"{_base(ctx)}/v1/versions/{version_id}/export/{format}"})


@mcp.tool()
def list_examples() -> str:
    """Example build123d programs (bracket, flange, gear, enclosure, quadruped leg assembly)."""
    return json.dumps(examples.EXAMPLES)


@mcp.tool()
def usage(ctx: Context) -> str:
    """Your plan, this month's usage and limits."""
    try:
        return json.dumps(core.me(_who(ctx)))
    except core.ApiError as e:
        return _err(e)
