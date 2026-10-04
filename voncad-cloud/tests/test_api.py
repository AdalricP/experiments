"""End-to-end tests against the real app (kernel, store, renderer, MCP).
    cd voncad-cloud && python -m pytest -q tests
"""
import json
import os
import sys
import tempfile

os.environ["VONCAD_DATA"] = tempfile.mkdtemp(prefix="voncad-test-")
os.environ["VONCAD_ADMIN_KEY"] = "vc_test_admin"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import pytest
from fastapi.testclient import TestClient

import app as appmod
import examples

H = {"Authorization": "Bearer vc_test_admin"}


@pytest.fixture(scope="module")
def client():
    with TestClient(appmod.app) as c:
        yield c


@pytest.fixture(scope="module")
def flange(client):
    r = client.post("/v1/build", json={"script": examples.FLANGE}, headers=H).json()
    assert r["ok"], r.get("error")
    return r


def test_health(client):
    assert client.get("/v1/health").json()["ok"]


@pytest.mark.parametrize("ex", examples.EXAMPLES, ids=lambda e: e["id"])
def test_examples_build(client, ex):
    r = client.post("/v1/build", json={"script": ex["script"], "include_scene": False}, headers=H).json()
    assert r["ok"], r.get("error")
    assert r["summary"]["volume"] > 0
    assert all(p["valid"] for p in r["summary"]["parts"])
    assert r["steps"], "build steps should be captured"


def test_scene_format(client, flange):
    s = flange["scene"]
    assert s["format"] == "voncad-scene" and s["version"] == 1
    p = s["parts"][0]
    assert p["faces"][0]["id"] == "p0/f0"
    tri_total = sum(f["count"] for f in p["faces"])
    import base64
    assert len(base64.b64decode(p["indices"])) == tri_total * 3 * 4


def test_params_override(client):
    a = client.post("/v1/build", json={"script": examples.GEAR, "params": {"teeth": 12}, "include_scene": False}, headers=H).json()
    b = client.post("/v1/build", json={"script": examples.GEAR, "params": {"teeth": "30"}, "include_scene": False}, headers=H).json()
    assert a["ok"] and b["ok"]
    assert b["summary"]["bbox"]["max"][0] > a["summary"]["bbox"]["max"][0]
    assert {p["name"] for p in a["param_schema"]} >= {"teeth", "module"}


@pytest.mark.parametrize("script,needle", [
    ("import os", "not allowed"),
    ("x = ().__class__", "dunder"),
    ("open('/etc/passwd')", "not available"),
    ("from build123d import *\nresult = Box(1, 2)", "line 2"),
    ("x = 1", "no geometry"),
    # sandbox escapes found during review — must stay blocked
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
])
def test_sandbox_and_errors(client, script, needle):
    r = client.post("/v1/build", json={"script": script}, headers=H).json()
    assert not r["ok"] and needle in r["error"]


@pytest.mark.parametrize("fmt", ["step", "stl", "glb", "3mf", "brep", "svg", "dxf", "obj"])
def test_exports(client, flange, fmt):
    r = client.get(f"/v1/versions/{flange['id']}/export/{fmt}")
    assert r.status_code == 200 and len(r.content) > 500


def test_render_and_report(client, flange):
    vid = flange["id"]
    for path in ("render.png?view=top&labels=true&highlight=p0/f3", "render-grid.png", "explainer.gif"):
        r = client.get(f"/v1/versions/{vid}/{path}")
        assert r.status_code == 200 and r.headers["content-type"].startswith("image/")
    r = client.get(f"/v1/versions/{vid}/report")
    assert r.status_code == 200 and "Design report" in r.text


def test_analysis(client, flange):
    vid = flange["id"]
    m = client.post(f"/v1/versions/{vid}/measure", json={"a": "p0/f0", "b": "p0/f3"}).json()
    assert "distance" in m
    s = client.post(f"/v1/versions/{vid}/section", json={"origin": [0, 0, 4], "normal": [0, 1, 0]}).json()
    assert s["area"] > 0 and s["svg"].startswith("<svg")
    mass = client.get(f"/v1/versions/{vid}/mass?density=2.7").json()
    assert abs(mass["mass_g"] - flange["summary"]["volume"] / 1000 * 2.7) < 1
    chk = client.post(f"/v1/versions/{vid}/check", json={"process": "fdm"}).json()
    assert chk["ok"] in (True, False) and "issues" in chk
    topo = client.get(f"/v1/versions/{vid}/topology?type=cylinder").json()
    assert all(f["type"] == "cylinder" for f in topo["parts"][0]["faces"])


def test_documents_versions_diff(client):
    d = client.post("/v1/documents", json={"name": "bracket", "script": examples.BRACKET}, headers=H).json()
    did, v1 = d["document"]["id"], d["version"]["id"]
    v2 = client.post(f"/v1/documents/{did}/versions", json={"params": {"width": 80}, "message": "wider"}, headers=H).json()["version"]
    assert v2["ok"] and v2["parent"] == v1 and v2["params"]["width"] == 80
    doc = client.get(f"/v1/documents/{did}", headers=H).json()
    assert [v["id"] for v in doc["versions"]] == [v1, v2["id"]]
    df = client.get(f"/v1/diff?a={v1}&b={v2['id']}").json()
    assert df["volume_added"] > 0 and not df["identical"]
    # someone else cannot modify it
    other = client.post("/v1/keys", json={"email": "other@example.com"}).json()["api_key"]
    r = client.post(f"/v1/documents/{did}/versions", json={"params": {}}, headers={"Authorization": f"Bearer {other}"})
    assert r.status_code == 404


def test_import_step_roundtrip(client, flange):
    step = client.get(f"/v1/versions/{flange['id']}/export/step").content
    r = client.post("/v1/import", files={"file": ("flange.step", step)}, headers=H).json()
    assert r["version"]["ok"]
    assert r["version"]["summary"]["parts"][0]["faces"] == flange["summary"]["parts"][0]["faces"]


def test_keys_and_auth(client):
    k = client.post("/v1/keys", json={"email": "a@b.co"}).json()
    assert k["api_key"].startswith("vc_")
    me = client.get("/v1/me", headers={"Authorization": f"Bearer {k['api_key']}"}).json()
    assert me["plan"] == "free"
    assert client.get("/v1/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/v1/me").json()["anonymous"]


def test_mcp_tools(client):
    hdr = {**H, "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
    r = client.post("/mcp", json=init, headers=hdr)
    assert r.status_code == 200, r.text
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=hdr)
    names = {t["name"] for t in r.json()["result"]["tools"]}
    assert {"build_model", "render_view", "measure", "export_model", "get_build_steps"} <= names
    call = {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "build_model", "arguments": {"script": "from build123d import *\nresult = Box(10, 10, 10)"}}}
    res = client.post("/mcp", json=call, headers=hdr).json()["result"]["content"]
    assert json.loads(res[0]["text"])["ok"]
    assert res[1]["type"] == "image"


def test_agent_loop_with_fake_model(client, monkeypatch):
    """The text-to-CAD loop: bad program -> error fed back -> good program -> renders -> DONE."""
    import agent

    replies = iter([
        "```python\nfrom build123d import *\nresult = Box(10, 10)\n```\nFirst try.",
        "```python\nfrom build123d import *\nparams = {'size': 20}\nresult = Box(params['size'], 20, 5) - Cylinder(3, 5)\n```\nFixed.",
        "DONE",
    ])
    seen = []

    def fake_ask(messages):
        seen.append(messages[-1])
        return next(replies)

    monkeypatch.setattr(agent, "available", lambda: True)
    monkeypatch.setattr(agent, "_ask", fake_ask)
    assert client.post("/v1/agent", json={"prompt": "a plate"}).status_code == 401  # anonymous
    r = client.post("/v1/agent", json={"prompt": "a 20 mm plate with a hole"}, headers=H).json()
    assert r["ok"] and len(r["rounds"]) == 2
    assert not r["rounds"][0]["ok"] and "line 2" in r["rounds"][0]["error"]
    assert r["version"]["param_schema"][0]["name"] == "size"
    # the model was shown the error, then an image of the result
    assert "build failed" in seen[1]["content"]
    assert seen[2]["content"][0]["type"] == "image"


def test_interference_and_bom(client):
    script = ("from build123d import *\n"
              "a = Box(10, 10, 10); a.label = 'a'\n"
              "b = Box(10, 10, 10).moved(Location((5, 0, 0))); b.label = 'b'\n"
              "c = Box(10, 10, 10).moved(Location((40, 0, 0))); c.label = 'c'\n"
              "result = Compound(children=[a, b, c])")
    v = client.post("/v1/build", json={"script": script, "include_scene": False}, headers=H).json()
    assert v["ok"], v.get("error")
    i = client.get(f"/v1/versions/{v['id']}/interference").json()
    assert len(i["clashes"]) == 1 and abs(i["clashes"][0]["volume_mm3"] - 500) < 1
    b = client.get(f"/v1/versions/{v['id']}/bom?density=1.24").json()
    assert b["unique_parts"] == 1 and b["items"][0]["quantity"] == 3
