#!/usr/bin/env python3
"""Voncad Cloud client: one file, standard library only. Use as a CLI or import as a module.

    export VONCAD_API=https://your-host  VONCAD_KEY=vc_...
    voncad.py key you@example.com              # get a free API key
    voncad.py build part.py --step part.step --png part.png -p width=80
    voncad.py render v_abc123 --view top --labels -o top.png
    voncad.py export v_abc123 stl -o part.stl
    voncad.py measure v_abc123 p0/f3 p0/f7
    voncad.py check v_abc123 --process cnc
    voncad.py watch part.py --step part.step   # rebuild on save (pairs with the Voncad terminal viewer)

    from voncad import Client
    c = Client()
    v = c.build(open("part.py").read(), params={"width": 80})
    open("part.step", "wb").write(c.export(v["id"], "step"))
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_API = os.environ.get("VONCAD_API", "http://localhost:8000")


class VoncadError(Exception):
    pass


class Client:
    def __init__(self, api: str | None = None, key: str | None = None, timeout: float = 300):
        self.api = (api or DEFAULT_API).rstrip("/")
        self.key = key if key is not None else os.environ.get("VONCAD_KEY")
        self.timeout = timeout

    def _req(self, method, path, body=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.api + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.key:
            req.add_header("Authorization", f"Bearer {self.key}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                out = r.read()
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read())["error"]["message"]
            except Exception:
                msg = str(e)
            raise VoncadError(f"{e.code}: {msg}") from None
        return out if raw else json.loads(out)

    # --- API
    def create_key(self, email):
        return self._req("POST", "/v1/keys", {"email": email})

    def me(self):
        return self._req("GET", "/v1/me")

    def build(self, script, params=None, quality="normal", include_scene=False):
        return self._req("POST", "/v1/build", {"script": script, "params": params or {}, "quality": quality,
                                               "include_scene": include_scene})

    def create_document(self, name, script, params=None, public=False):
        return self._req("POST", "/v1/documents", {"name": name, "script": script, "params": params, "public": public})

    def new_version(self, document_id, script=None, params=None, message=None):
        return self._req("POST", f"/v1/documents/{document_id}/versions",
                         {"script": script, "params": params, "message": message})["version"]

    def version(self, vid):
        return self._req("GET", f"/v1/versions/{vid}")

    def topology(self, vid):
        return self._req("GET", f"/v1/versions/{vid}/topology")

    def render(self, vid, view="iso", w=800, h=600, labels=False, highlight=()):
        q = f"view={view}&w={w}&h={h}&labels={'true' if labels else 'false'}&highlight={','.join(highlight)}"
        return self._req("GET", f"/v1/versions/{vid}/render.png?{q}", raw=True)

    def export(self, vid, fmt="step"):
        return self._req("GET", f"/v1/versions/{vid}/export/{fmt}", raw=True)

    def measure(self, vid, a, b=None):
        return self._req("POST", f"/v1/versions/{vid}/measure", {"a": a, "b": b})

    def section(self, vid, origin=(0, 0, 0), normal=(0, 0, 1)):
        return self._req("POST", f"/v1/versions/{vid}/section", {"origin": list(origin), "normal": list(normal)})

    def mass(self, vid, density=7.85):
        return self._req("GET", f"/v1/versions/{vid}/mass?density={density}")

    def check(self, vid, process="fdm"):
        return self._req("POST", f"/v1/versions/{vid}/check", {"process": process})

    def diff(self, a, b):
        return self._req("GET", f"/v1/diff?a={a}&b={b}")


def _params(items):
    out = {}
    for it in items or []:
        k, _, v = it.partition("=")
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            out[k] = v
    return out


def _report(c, v, a):
    if not v["ok"]:
        print(f"✗ build failed: {v['error']}", file=sys.stderr)
        if v.get("logs"):
            print(v["logs"], file=sys.stderr)
        return 1
    s = v["summary"]
    lo, hi = s["bbox"]["min"], s["bbox"]["max"]
    print(f"✓ {v['id']}  {len(s['parts'])} part(s)  {s['volume']:,.1f} mm³  "
          f"{hi[0]-lo[0]:.1f}×{hi[1]-lo[1]:.1f}×{hi[2]-lo[2]:.1f} mm  {s.get('timing_ms', {}).get('total', '?')} ms")
    for st in v.get("steps", [])[:50]:
        print(f"   {st['index'] + 1:>2}. {st['description']}")
    for fmt in ("step", "stl", "glb", "3mf"):
        path = getattr(a, fmt.replace("3mf", "tmf"), None)
        if path:
            open(path, "wb").write(c.export(v["id"], fmt))
            print(f"   → {path}")
    if getattr(a, "png", None):
        open(a.png, "wb").write(c.render(v["id"], labels=True))
        print(f"   → {a.png}")
    print(f"   viewer: {c.api}/view.html?v={v['id']}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="voncad", description="Voncad Cloud CLI")
    p.add_argument("--api", default=DEFAULT_API)
    p.add_argument("--key", default=None)
    sub = p.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("key", help="create a free API key")
    k.add_argument("email")
    sub.add_parser("me", help="plan and usage")
    for name in ("build", "watch"):
        b = sub.add_parser(name, help="build a build123d script" if name == "build" else "rebuild on every save")
        b.add_argument("script")
        b.add_argument("-p", "--param", action="append", help="override a param: name=value")
        b.add_argument("--quality", default="normal", choices=["draft", "normal", "fine"])
        b.add_argument("--step"); b.add_argument("--stl"); b.add_argument("--glb")
        b.add_argument("--3mf", dest="tmf"); b.add_argument("--png")
    r = sub.add_parser("render", help="render a version to PNG")
    r.add_argument("version"); r.add_argument("--view", default="iso"); r.add_argument("--labels", action="store_true")
    r.add_argument("--highlight", default=""); r.add_argument("-o", "--out", default="render.png")
    e = sub.add_parser("export", help="download a version")
    e.add_argument("version"); e.add_argument("format"); e.add_argument("-o", "--out")
    m = sub.add_parser("measure", help="measure one or two refs")
    m.add_argument("version"); m.add_argument("a"); m.add_argument("b", nargs="?")
    ch = sub.add_parser("check", help="manufacturability check")
    ch.add_argument("version"); ch.add_argument("--process", default="fdm")
    d = sub.add_parser("diff", help="geometric diff of two versions")
    d.add_argument("a"); d.add_argument("b")
    t = sub.add_parser("topology", help="faces and edges with ids")
    t.add_argument("version")
    a = p.parse_args(argv)
    c = Client(a.api, a.key)
    try:
        if a.cmd == "key":
            r = c.create_key(a.email)
            print(f"export VONCAD_KEY={r['api_key']}")
        elif a.cmd == "me":
            print(json.dumps(c.me(), indent=2))
        elif a.cmd == "build":
            return _report(c, c.build(open(a.script).read(), _params(a.param), a.quality), a)
        elif a.cmd == "watch":
            last = None
            print(f"watching {a.script} (Ctrl+C to stop)")
            while True:
                mt = os.path.getmtime(a.script)
                if mt != last:
                    last = mt
                    _report(c, c.build(open(a.script).read(), _params(a.param), a.quality), a)
                time.sleep(0.5)
        elif a.cmd == "render":
            open(a.out, "wb").write(c.render(a.version, a.view, labels=a.labels,
                                             highlight=[x for x in a.highlight.split(",") if x]))
            print(a.out)
        elif a.cmd == "export":
            out = a.out or f"{a.version}.{a.format}"
            open(out, "wb").write(c.export(a.version, a.format))
            print(out)
        elif a.cmd == "measure":
            print(json.dumps(c.measure(a.version, a.a, a.b), indent=2))
        elif a.cmd == "check":
            print(json.dumps(c.check(a.version, a.process), indent=2))
        elif a.cmd == "diff":
            print(json.dumps(c.diff(a.a, a.b), indent=2))
        elif a.cmd == "topology":
            print(json.dumps(c.topology(a.version), indent=1))
    except VoncadError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
