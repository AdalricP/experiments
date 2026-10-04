import base64
import json
import os
import sys
import tempfile

os.environ["BISCAD_DATA"] = tempfile.mkdtemp(prefix="biscad-test-")
os.environ["BISCAD_ADMIN_KEY"] = "bsc_test_admin"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import pytest
from fastapi.testclient import TestClient

import agent
import app as application_module
import examples

ADMIN_HEADERS = {"Authorization": "Bearer bsc_test_admin"}
SANDBOX_ESCAPES_AND_SCRIPT_ERRORS = [
    ("import os", "not allowed"),
    ("x = ().__class__", "dunder"),
    ("open('/etc/passwd')", "not available"),
    ("from build123d import *\nresult = Box(1, 2)", "line 2"),
    ("x = 1", "no geometry"),
    ("import build123d\nbuild123d.exporters.os.getcwd()", "not available"),
    ("from build123d import *\nexport_stl(Box(1,1,1), '/tmp/x.stl')", "not available"),
    ("from build123d import *\nf = Box(1,1,1).export_step", "not available"),
    ("import numpy as np\nnp.save('/tmp/x.npy', np.zeros(3))", "not available"),
    ("import numpy as np\nnp.loadtxt('/etc/hostname')", "not available"),
    ("import typing\ntyping.sys", "not available"),
    ("import re\nre.enum", "no attribute"),
    ("g = (x for x in [1])\ng.gi_frame", "not available"),
    ("'{0.__class__}'.format(1)", "'__'"),
    ("from build123d import *\nos", "not available"),
    ("import build123d.exporters", "not allowed"),
]


@pytest.fixture(scope="module")
def api_client():
    with TestClient(application_module.app) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def flange_version(api_client):
    version = api_client.post("/v1/build", json={"script": examples.FLANGE}, headers=ADMIN_HEADERS).json()
    assert version["ok"], version.get("error")
    return version


def build_without_scene(api_client, script, params=None):
    return api_client.post("/v1/build", json={"script": script, "params": params, "include_scene": False},
                           headers=ADMIN_HEADERS).json()


def test_health_reports_ok(api_client):
    assert api_client.get("/v1/health").json()["ok"]


@pytest.mark.parametrize("example", examples.EXAMPLES, ids=lambda example: example["id"])
def test_every_example_builds_with_steps(api_client, example):
    version = build_without_scene(api_client, example["script"])
    assert version["ok"], version.get("error")
    assert version["summary"]["volume"] > 0
    assert all(part["valid"] for part in version["summary"]["parts"])
    assert version["steps"], "build steps should be captured"


def test_scene_format_maps_triangles_to_faces(flange_version):
    scene = flange_version["scene"]
    assert scene["format"] == "biscad-scene" and scene["version"] == 1
    first_part = scene["parts"][0]
    assert first_part["faces"][0]["id"] == "p0/f0"
    total_triangle_count = sum(face["count"] for face in first_part["faces"])
    assert len(base64.b64decode(first_part["indices"])) == total_triangle_count * 3 * 4


def test_params_override_changes_geometry(api_client):
    small_gear = build_without_scene(api_client, examples.GEAR, {"teeth": 12})
    large_gear = build_without_scene(api_client, examples.GEAR, {"teeth": "30"})
    assert small_gear["ok"] and large_gear["ok"]
    assert large_gear["summary"]["bbox"]["max"][0] > small_gear["summary"]["bbox"]["max"][0]
    assert {parameter["name"] for parameter in small_gear["param_schema"]} >= {"teeth", "module"}


@pytest.mark.parametrize("script,expected_error_fragment", SANDBOX_ESCAPES_AND_SCRIPT_ERRORS)
def test_sandbox_blocks_escapes_and_reports_errors(api_client, script, expected_error_fragment):
    version = api_client.post("/v1/build", json={"script": script}, headers=ADMIN_HEADERS).json()
    assert not version["ok"] and expected_error_fragment in version["error"]


@pytest.mark.parametrize("export_format", ["step", "stl", "glb", "3mf", "brep", "svg", "dxf", "obj"])
def test_every_export_format_downloads(api_client, flange_version, export_format):
    response = api_client.get(f"/v1/versions/{flange_version['id']}/export/{export_format}")
    assert response.status_code == 200 and len(response.content) > 500


def test_renders_explainer_and_report_are_served(api_client, flange_version):
    version_id = flange_version["id"]
    for image_path in ("render.png?view=top&labels=true&highlight=p0/f3", "render-grid.png", "explainer.gif"):
        response = api_client.get(f"/v1/versions/{version_id}/{image_path}")
        assert response.status_code == 200 and response.headers["content-type"].startswith("image/")
    response = api_client.get(f"/v1/versions/{version_id}/report")
    assert response.status_code == 200 and "Design report" in response.text


def test_measure_section_mass_check_and_topology(api_client, flange_version):
    version_id = flange_version["id"]
    measurement = api_client.post(f"/v1/versions/{version_id}/measure", json={"a": "p0/f0", "b": "p0/f3"}).json()
    assert "distance" in measurement
    cross_section = api_client.post(f"/v1/versions/{version_id}/section",
                                    json={"origin": [0, 0, 4], "normal": [0, 1, 0]}).json()
    assert cross_section["area"] > 0 and cross_section["svg"].startswith("<svg")
    mass = api_client.get(f"/v1/versions/{version_id}/mass?density=2.7").json()
    assert abs(mass["mass_g"] - flange_version["summary"]["volume"] / 1000 * 2.7) < 1
    manufacturability = api_client.post(f"/v1/versions/{version_id}/check", json={"process": "fdm"}).json()
    assert manufacturability["ok"] in (True, False) and "issues" in manufacturability
    topology = api_client.get(f"/v1/versions/{version_id}/topology?type=cylinder").json()
    assert all(face["type"] == "cylinder" for face in topology["parts"][0]["faces"])


def test_documents_versions_diff_and_ownership(api_client):
    created = api_client.post("/v1/documents", json={"name": "bracket", "script": examples.BRACKET},
                              headers=ADMIN_HEADERS).json()
    document_id, first_version_id = created["document"]["id"], created["version"]["id"]
    second_version = api_client.post(f"/v1/documents/{document_id}/versions",
                                     json={"params": {"width": 80}, "message": "wider"}, headers=ADMIN_HEADERS).json()["version"]
    assert second_version["ok"] and second_version["parent"] == first_version_id
    assert second_version["params"]["width"] == 80
    document = api_client.get(f"/v1/documents/{document_id}", headers=ADMIN_HEADERS).json()
    assert [version["id"] for version in document["versions"]] == [first_version_id, second_version["id"]]
    geometric_diff = api_client.get(f"/v1/diff?a={first_version_id}&b={second_version['id']}").json()
    assert geometric_diff["volume_added"] > 0 and not geometric_diff["identical"]
    other_api_key = api_client.post("/v1/keys", json={"email": "other@example.com"}).json()["api_key"]
    response = api_client.post(f"/v1/documents/{document_id}/versions", json={"params": {}},
                               headers={"Authorization": f"Bearer {other_api_key}"})
    assert response.status_code == 404


def test_step_import_round_trip_keeps_faces(api_client, flange_version):
    step_bytes = api_client.get(f"/v1/versions/{flange_version['id']}/export/step").content
    imported = api_client.post("/v1/import", files={"file": ("flange.step", step_bytes)}, headers=ADMIN_HEADERS).json()
    assert imported["version"]["ok"]
    assert imported["version"]["summary"]["parts"][0]["faces"] == flange_version["summary"]["parts"][0]["faces"]


def test_keys_plans_and_authentication(api_client):
    created_key = api_client.post("/v1/keys", json={"email": "a@b.co"}).json()
    assert created_key["api_key"].startswith("bsc_")
    plan_and_usage = api_client.get("/v1/me", headers={"Authorization": f"Bearer {created_key['api_key']}"}).json()
    assert plan_and_usage["plan"] == "free"
    assert api_client.get("/v1/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert api_client.get("/v1/me").json()["anonymous"]


def test_mcp_lists_tools_and_builds_with_render(api_client):
    mcp_headers = {**ADMIN_HEADERS, "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    initialize_request = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
    response = api_client.post("/mcp", json=initialize_request, headers=mcp_headers)
    assert response.status_code == 200, response.text
    response = api_client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=mcp_headers)
    tool_names = {tool["name"] for tool in response.json()["result"]["tools"]}
    assert {"build_model", "render_view", "measure", "export_model", "get_build_steps"} <= tool_names
    build_call = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
        "name": "build_model", "arguments": {"script": "from build123d import *\nresult = Box(10, 10, 10)"}}}
    content = api_client.post("/mcp", json=build_call, headers=mcp_headers).json()["result"]["content"]
    assert json.loads(content[0]["text"])["ok"]
    assert content[1]["type"] == "image"


def test_agent_loop_feeds_back_errors_then_renders(api_client, monkeypatch):
    scripted_replies = iter([
        "```python\nfrom build123d import *\nresult = Box(10, 10)\n```\nFirst try.",
        "```python\nfrom build123d import *\nparams = {'size': 20}\nresult = Box(params['size'], 20, 5) - Cylinder(3, 5)\n```\nFixed.",
        "DONE",
    ])
    messages_shown_to_model = []

    def reply_with_next_scripted_answer(messages):
        messages_shown_to_model.append(messages[-1])
        return next(scripted_replies)

    monkeypatch.setattr(agent, "is_available", lambda: True)
    monkeypatch.setattr(agent, "ask_model_for_reply", reply_with_next_scripted_answer)
    assert api_client.post("/v1/agent", json={"prompt": "a plate"}).status_code == 401
    agent_run = api_client.post("/v1/agent", json={"prompt": "a 20 mm plate with a hole"}, headers=ADMIN_HEADERS).json()
    assert agent_run["ok"] and len(agent_run["rounds"]) == 2
    assert not agent_run["rounds"][0]["ok"] and "line 2" in agent_run["rounds"][0]["error"]
    assert agent_run["version"]["param_schema"][0]["name"] == "size"
    assert "build failed" in messages_shown_to_model[1]["content"]
    assert messages_shown_to_model[2]["content"][0]["type"] == "image"


def test_interference_and_bill_of_materials(api_client):
    script = ("from build123d import *\n"
              "a = Box(10, 10, 10); a.label = 'a'\n"
              "b = Box(10, 10, 10).moved(Location((5, 0, 0))); b.label = 'b'\n"
              "c = Box(10, 10, 10).moved(Location((40, 0, 0))); c.label = 'c'\n"
              "result = Compound(children=[a, b, c])")
    version = build_without_scene(api_client, script)
    assert version["ok"], version.get("error")
    interference = api_client.get(f"/v1/versions/{version['id']}/interference").json()
    assert len(interference["clashes"]) == 1 and abs(interference["clashes"][0]["volume_mm3"] - 500) < 1
    bill = api_client.get(f"/v1/versions/{version['id']}/bom?density=1.24").json()
    assert bill["unique_parts"] == 1 and bill["items"][0]["quantity"] == 3
