from __future__ import annotations

import functools
import json

from mcp.server.fastmcp import Context, FastMCP, Image
from mcp.server.transport_security import TransportSecuritySettings

import analysis
import core
import examples
import store
from render import VIEW_DIRECTIONS, render_four_view_grid_png, render_version_png

GUIDE = """BISCAD builds CAD models from build123d (Python) programs on an OpenCascade B-rep kernel.

Workflow: build_model (or create_document + update_document for versioned work) -> look at the returned
render -> get_topology to find face/edge ids -> measure / section / check_manufacturability -> export_model.

Script rules:
- `from build123d import *`. Allowed imports: build123d, math, numpy, random, itertools, functools,
  collections, typing, dataclasses, enum, copy, statistics, fractions, decimal, string, re, constraint_sketch.
- Put the final shape in `result` (a Part, Compound, list or dict of shapes) or call `show(shape, ...)`.
- Declare tunable values as a literal dict at top level: `params = {"width": 40, "hole": 6.5}`;
  callers can override them per build (configurations). Units are millimetres, Z is up.
- Assemblies: give children `.label` and `.color = Color(r, g, b)` and return
  `Compound(children=[...])`.
- No file, network or OS access. Builds time out (30-180 s by plan).

References: faces/edges/vertices are named `p<part>/f<n>`, `p<part>/e<n>`, `p<part>/v<n>`; n is the
index in build123d's `part.faces()` / `part.edges()` order, so `p0/f3` is `result.faces()[3]` for a
single part. Ids are stable for the same program and parameters. Each face also has a persistent id
`p<part>/#<hash>` from its build history (topology `persistent_id`). It survives parameter changes and
added features. Use it anywhere a face id is accepted when you keep a reference across edits.

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
Constraint sketch: `s = ConstraintSketch(); a = s.point(0, 0, fixed=True); b = s.point(40, 3); l = s.line(a, b); s.horizontal(l); s.length(l, 60)`
(+ vertical parallel perpendicular distance equal angle radius tangent midpoint point_on_line coincident; circle(center, radius=)) -> `sol = s.solve()` (sol.degrees_of_freedom; error names the conflict) -> `extrude(sol.face(), 6)`.
"""
MAX_LOG_CHARACTERS_IN_FAILURE_HINT = 1500
MAX_STDOUT_CHARACTERS_IN_BRIEF = 2000
GRID_TILE_SIZE_IN_PIXELS = 400

mcp = FastMCP(
    "biscad",
    instructions=GUIDE,
    stateless_http=True,
    json_response=True,
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


def _http_request_of(context: Context):
    try:
        return context.request_context.request
    except Exception:
        return None


def _identify_and_admit_caller(context: Context) -> dict:
    http_request = _http_request_of(context)
    client = getattr(http_request, "client", None) if http_request is not None else None
    return core.identify_and_admit_caller(getattr(http_request, "headers", {}) or {}, client.host if client else None)


def _public_base_url(context: Context) -> str:
    try:
        http_request = context.request_context.request
        protocol = http_request.headers.get("x-forwarded-proto", http_request.url.scheme)
        host = http_request.headers.get("x-forwarded-host", http_request.headers.get("host"))
        return f"{protocol}://{host}"
    except Exception:
        return ""


def _compact_json(content) -> str:
    return json.dumps(content, separators=(",", ":"))


def _error_json(api_error: core.ApiError) -> str:
    return json.dumps({"error": api_error.code, "message": api_error.message})


def _registered_tool(returns_content_list: bool = False):
    def register(tool_function):
        @functools.wraps(tool_function)
        def tool_with_api_errors_as_json(*arguments, **keyword_arguments):
            try:
                return tool_function(*arguments, **keyword_arguments)
            except core.ApiError as api_error:
                return [_error_json(api_error)] if returns_content_list else _error_json(api_error)
        return mcp.tool()(tool_with_api_errors_as_json)
    return register


def _version_brief(version: dict, base_url: str) -> dict:
    brief = {"version_id": version["id"], "ok": version["ok"], "document_id": version.get("document_id")}
    if not version["ok"]:
        logs_tail = (version.get("logs") or "")[-MAX_LOG_CHARACTERS_IN_FAILURE_HINT:]
        return brief | {"error": version["error"], "hint": "Fix the script and build again. Logs: " + logs_tail}
    summary = version["summary"]
    part_fields = ("id", "name", "volume", "faces", "edges", "solids", "valid")
    brief["summary"] = {
        "bbox": summary["bbox"], "volume_mm3": summary["volume"], "area_mm2": summary["area"],
        "center_of_mass": summary["center_of_mass"],
        "mass_g": {"steel": summary["mass_g_steel"], "aluminium": summary["mass_g_aluminium"], "pla": summary["mass_g_pla"]},
        "parts": [{field: part[field] for field in part_fields} | {"size": part["bbox"]["size"]} for part in summary["parts"]],
        "build_ms": summary.get("timing_ms", {}).get("total"),
    }
    brief["param_schema"] = version["param_schema"]
    brief["steps"] = [f"{step['index'] + 1}. {step['description']}" for step in version["steps"]]
    brief["viewer_url"] = f"{base_url}/view.html?v={version['id']}"
    brief["report_url"] = f"{base_url}/v1/versions/{version['id']}/report"
    if version.get("logs"):
        brief["stdout"] = version["logs"][-MAX_STDOUT_CHARACTERS_IN_BRIEF:]
    return brief


def _render_image(version_id: str, view="iso", labels=True, highlight=()) -> Image:
    png_bytes = render_version_png(store.directory_for_version(version_id), view, 720, 540, labels=labels,
                                   highlight=list(highlight))
    return Image(data=png_bytes, format="png")


def _brief_with_iso_render(version: dict, context: Context, should_render: bool = True, extra_fields=None) -> list:
    content = [_compact_json((extra_fields or {}) | _version_brief(version, _public_base_url(context)))]
    return content + [_render_image(version["id"])] if version["ok"] and should_render else content


def _analysis_json(context: Context, version_id: str, analysis_function, *arguments, timeout_in_seconds=60.0) -> str:
    _identify_and_admit_caller(context)
    return json.dumps(core.run_analysis_on_version(version_id, analysis_function, *arguments,
                                                   timeout_in_seconds=timeout_in_seconds))


@_registered_tool(returns_content_list=True)
def build_model(script: str, context: Context, params: dict | None = None, render: bool = True) -> list:
    """Build a build123d program. Returns a summary (bbox, volume, mass, parts, build steps, param
    schema, viewer URL) and an iso render with face ids labelled. Not saved to a document; use
    create_document for versioned work. The returned version_id works with every other tool."""
    version = core.build_version(_identify_and_admit_caller(context), script, params)
    return _brief_with_iso_render(version, context, should_render=render)


@_registered_tool(returns_content_list=True)
def create_document(name: str, script: str, context: Context, params: dict | None = None, public: bool = False) -> list:
    """Create a versioned document from a build123d program and build its first version."""
    created = core.create_document(_identify_and_admit_caller(context), name, script, params, public)
    return _brief_with_iso_render(created["version"], context, extra_fields={"document_id": created["document"]["id"]})


@_registered_tool(returns_content_list=True)
def update_document(document_id: str, context: Context, script: str | None = None, params: dict | None = None,
                    message: str | None = None, parent_version_id: str | None = None) -> list:
    """Add a new version to a document: a new script and/or parameter overrides (omitted script reuses
    the parent's). Parent defaults to the document head. Returns summary + render."""
    caller = _identify_and_admit_caller(context)
    return _brief_with_iso_render(core.build_new_document_version(caller, document_id, script, params,
                                                                  parent_version_id, message), context)


@_registered_tool()
def list_documents(context: Context) -> str:
    """List your documents (most recently updated first)."""
    listed_fields = ("id", "name", "head", "updated", "public")
    documents = store.list_documents(_identify_and_admit_caller(context)["owner"])
    return json.dumps([{field: document[field] for field in listed_fields} for document in documents])


@_registered_tool()
def get_document(document_id: str, context: Context) -> str:
    """A document and its version history."""
    return _compact_json(core.get_visible_document_with_history(_identify_and_admit_caller(context), document_id))


@_registered_tool()
def get_script(version_id: str, context: Context) -> str:
    """The build123d source and parameters of a version (to edit and rebuild)."""
    _identify_and_admit_caller(context)
    version = core.get_version(version_id)
    return _compact_json({"script": version["script"], "params": version["params"], "param_schema": version["param_schema"]})


@_registered_tool()
def get_topology(version_id: str, context: Context, type: str | None = None, limit: int | None = 200) -> str:
    """Faces and edges with stable ids (p0/f3, p0/e7) and face persistent_id (p0/#1a2b3c4d), type
    (plane, cylinder, line, circle...), area or length, centre, normal, radius, axis. Filter with type,
    e.g. 'cylinder' or 'circle'."""
    _identify_and_admit_caller(context)
    return json.dumps(core.filtered_topology(version_id, type, limit))


@_registered_tool(returns_content_list=True)
def render_view(version_id: str, context: Context, view: str = "iso", labels: bool = True,
                highlight: list[str] | None = None) -> list:
    """Render a version to an image. view: iso, iso2, iso_back, iso_below, front, back, left, right,
    top, bottom. labels draws face ids; highlight paints the given ids (e.g. ['p0/f3'] or ['p0/#1a2b3c4d']) orange."""
    _identify_and_admit_caller(context)
    core.get_successful_version(version_id)
    if view not in VIEW_DIRECTIONS:
        raise core.ApiError(400, f"view must be one of {', '.join(VIEW_DIRECTIONS)}")
    return [_render_image(version_id, view, labels, highlight or ())]


@_registered_tool(returns_content_list=True)
def render_grid(version_id: str, context: Context, labels: bool = False) -> list:
    """Iso, front, top and right views in one image: the fastest way to check a model."""
    _identify_and_admit_caller(context)
    core.get_successful_version(version_id)
    grid_png = render_four_view_grid_png(store.directory_for_version(version_id), GRID_TILE_SIZE_IN_PIXELS, labels)
    return [Image(data=grid_png, format="png")]


@_registered_tool()
def get_build_steps(version_id: str, context: Context) -> str:
    """How the model was built: one entry per operation, with a plain-English description, the
    script line, and volume/face counts after the step."""
    _identify_and_admit_caller(context)
    version = core.public_view_of_version(core.get_successful_version(version_id))
    step_fields = ("index", "op", "line", "description", "volume", "faces")
    return _compact_json([{field: step[field] for field in step_fields} for step in version["steps"]])


@_registered_tool()
def measure(version_id: str, a: str, context: Context, b: str | None = None) -> str:
    """Measure one entity (properties) or two (min distance, closest points, angle, parallel /
    perpendicular). Refs like 'p0/f3', 'p0/#1a2b3c4d', 'p0/e7', 'p0/v2' or a whole part 'p1'."""
    return _analysis_json(context, version_id, analysis.measure_references, a, b)


@_registered_tool()
def section(version_id: str, context: Context, origin: list[float] = [0, 0, 0], normal: list[float] = [0, 0, 1]) -> str:
    """Cut the model with a plane. Returns the cut area (mm²), number of regions, and an SVG of the section."""
    return _analysis_json(context, version_id, analysis.section_with_plane, origin, normal)


@_registered_tool()
def mass_properties(version_id: str, context: Context, density_g_cm3: float = 7.85) -> str:
    """Mass, centre of mass and inertia tensor per part for a density (steel 7.85, aluminium 2.70,
    PLA 1.24, ABS 1.04, titanium 4.43)."""
    return _analysis_json(context, version_id, analysis.mass_properties, density_g_cm3)


@_registered_tool()
def check_manufacturability(version_id: str, context: Context, process: str = "fdm") -> str:
    """DFM checks for 'fdm', 'cnc' or 'sheet': build envelope, validity, disconnected solids, tiny
    edges, overhangs, small radii, estimated minimum wall. Issues carry face/edge refs."""
    return _analysis_json(context, version_id, analysis.check_manufacturability, process)


@_registered_tool()
def check_interference(version_id: str, context: Context) -> str:
    """Clash detection for assemblies: which parts overlap, by how much volume, and where."""
    return _analysis_json(context, version_id, analysis.detect_interference, timeout_in_seconds=120)


@_registered_tool()
def bill_of_materials(version_id: str, context: Context, density_g_cm3: float | None = None) -> str:
    """BOM: identical parts grouped with quantities, sizes and (optionally) mass."""
    return _analysis_json(context, version_id, analysis.bill_of_materials, density_g_cm3)


@_registered_tool()
def diff_versions(version_a: str, version_b: str, context: Context) -> str:
    """Geometric diff between two versions: volume added/removed, faces added/removed, bbox change."""
    _identify_and_admit_caller(context)
    return json.dumps(core.run_in_isolated_kernel(analysis.diff_versions, core.successful_version_directory(version_a),
                                                  core.successful_version_directory(version_b)))


@_registered_tool()
def export_model(version_id: str, context: Context, format: str = "step") -> str:
    """Get a download URL for step, stl, glb, 3mf, brep, obj, svg (3-view drawing) or dxf."""
    _identify_and_admit_caller(context)
    core.get_successful_version(version_id)
    if format not in analysis.EXPORT_FORMATS:
        raise core.ApiError(400, f"format must be one of {', '.join(analysis.EXPORT_FORMATS)}")
    return json.dumps({"url": f"{_public_base_url(context)}/v1/versions/{version_id}/export/{format}"})


@_registered_tool()
def list_examples() -> str:
    """Example build123d programs (bracket, flange, gear, enclosure, quadruped leg assembly)."""
    return json.dumps(examples.EXAMPLES)


@_registered_tool()
def usage(context: Context) -> str:
    """Your plan, this month's usage and limits."""
    return json.dumps(core.describe_plan_and_usage(_identify_and_admit_caller(context)))
