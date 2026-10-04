#!/usr/bin/env python3
"""BISCAD client: one file, standard library only. Use as a CLI or import as a module.

    export BISCAD_API=https://your-host  BISCAD_KEY=bsc_...
    biscad.py key you@example.com              # get a free API key
    biscad.py build part.py --step part.step --png part.png -p width=80
    biscad.py render v_abc123 --view top --labels -o top.png
    biscad.py export v_abc123 stl -o part.stl
    biscad.py measure v_abc123 p0/f3 p0/f7
    biscad.py check v_abc123 --process cnc
    biscad.py watch part.py --step part.step   # rebuild on save (pairs with the BISCAD terminal viewer)

    from biscad import Client
    client = Client()
    version = client.build(open("part.py").read(), params={"width": 80})
    open("part.step", "wb").write(client.export(version["id"], "step"))
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_API = os.environ.get("BISCAD_API", "http://localhost:8000")
WATCH_POLL_INTERVAL_IN_SECONDS = 0.5
MAX_STEPS_PRINTED = 50


class BISCADError(Exception):
    pass


class Client:
    def __init__(self, api: str | None = None, key: str | None = None, timeout: float = 300):
        self.api = (api or DEFAULT_API).rstrip("/")
        self.key = key if key is not None else os.environ.get("BISCAD_KEY")
        self.timeout = timeout

    def _send_request(self, method, path, body=None, should_return_raw_bytes=False):
        encoded_body = json.dumps(body).encode() if body is not None else None
        http_request = urllib.request.Request(self.api + path, data=encoded_body, method=method)
        if encoded_body is not None:
            http_request.add_header("Content-Type", "application/json")
        if self.key:
            http_request.add_header("Authorization", f"Bearer {self.key}")
        try:
            with urllib.request.urlopen(http_request, timeout=self.timeout) as http_response:
                response_bytes = http_response.read()
        except urllib.error.HTTPError as http_error:
            raise BISCADError(f"{http_error.code}: {_error_message_of(http_error)}") from None
        return response_bytes if should_return_raw_bytes else json.loads(response_bytes)

    def create_key(self, email):
        return self._send_request("POST", "/v1/keys", {"email": email})

    def me(self):
        return self._send_request("GET", "/v1/me")

    def build(self, script, params=None, quality="normal", include_scene=False):
        return self._send_request("POST", "/v1/build", {"script": script, "params": params or {}, "quality": quality,
                                                        "include_scene": include_scene})

    def create_document(self, name, script, params=None, public=False):
        return self._send_request("POST", "/v1/documents", {"name": name, "script": script, "params": params,
                                                            "public": public})

    def new_version(self, document_id, script=None, params=None, message=None):
        return self._send_request("POST", f"/v1/documents/{document_id}/versions",
                                  {"script": script, "params": params, "message": message})["version"]

    def version(self, version_id):
        return self._send_request("GET", f"/v1/versions/{version_id}")

    def topology(self, version_id):
        return self._send_request("GET", f"/v1/versions/{version_id}/topology")

    def render(self, version_id, view="iso", width_in_pixels=800, height_in_pixels=600, labels=False, highlight=()):
        query = (f"view={view}&w={width_in_pixels}&h={height_in_pixels}&labels={'true' if labels else 'false'}"
                 f"&highlight={','.join(highlight)}")
        return self._send_request("GET", f"/v1/versions/{version_id}/render.png?{query}", should_return_raw_bytes=True)

    def export(self, version_id, export_format="step"):
        return self._send_request("GET", f"/v1/versions/{version_id}/export/{export_format}", should_return_raw_bytes=True)

    def measure(self, version_id, first_reference, second_reference=None):
        return self._send_request("POST", f"/v1/versions/{version_id}/measure",
                                  {"a": first_reference, "b": second_reference})

    def section(self, version_id, origin=(0, 0, 0), normal=(0, 0, 1)):
        return self._send_request("POST", f"/v1/versions/{version_id}/section",
                                  {"origin": list(origin), "normal": list(normal)})

    def mass(self, version_id, density=7.85):
        return self._send_request("GET", f"/v1/versions/{version_id}/mass?density={density}")

    def check(self, version_id, process="fdm"):
        return self._send_request("POST", f"/v1/versions/{version_id}/check", {"process": process})

    def diff(self, first_version_id, second_version_id):
        return self._send_request("GET", f"/v1/diff?a={first_version_id}&b={second_version_id}")


def _error_message_of(http_error: urllib.error.HTTPError) -> str:
    try:
        return json.loads(http_error.read())["error"]["message"]
    except Exception:
        return str(http_error)


def _parse_param_overrides(name_value_pairs):
    overrides = {}
    for name_value_pair in name_value_pairs or []:
        name, _separator, raw_value = name_value_pair.partition("=")
        try:
            overrides[name] = json.loads(raw_value)
        except json.JSONDecodeError:
            overrides[name] = raw_value
    return overrides


def _write_file_and_announce(path, file_bytes):
    with open(path, "wb") as output_file:
        output_file.write(file_bytes)
    print(f"   → {path}")


def _print_build_failure(version):
    print(f"✗ build failed: {version['error']}", file=sys.stderr)
    if version.get("logs"):
        print(version["logs"], file=sys.stderr)
    return 1


def _report_build(client, version, arguments):
    if not version["ok"]:
        return _print_build_failure(version)
    summary = version["summary"]
    lowest, highest = summary["bbox"]["min"], summary["bbox"]["max"]
    print(f"✓ {version['id']}  {len(summary['parts'])} part(s)  {summary['volume']:,.1f} mm³  "
          f"{highest[0]-lowest[0]:.1f}×{highest[1]-lowest[1]:.1f}×{highest[2]-lowest[2]:.1f} mm  "
          f"{summary.get('timing_ms', {}).get('total', '?')} ms")
    for step in version.get("steps", [])[:MAX_STEPS_PRINTED]:
        print(f"   {step['index'] + 1:>2}. {step['description']}")
    for export_format in ("step", "stl", "glb", "3mf"):
        output_path = getattr(arguments, export_format.replace("3mf", "tmf"), None)
        if output_path:
            _write_file_and_announce(output_path, client.export(version["id"], export_format))
    if getattr(arguments, "png", None):
        _write_file_and_announce(arguments.png, client.render(version["id"], labels=True))
    print(f"   viewer: {client.api}/view.html?v={version['id']}")
    return 0


def _build_script_file(client, arguments):
    with open(arguments.script) as script_file:
        script = script_file.read()
    return _report_build(client, client.build(script, _parse_param_overrides(arguments.param), arguments.quality), arguments)


def _watch_script_file(client, arguments):
    last_modification_time = None
    print(f"watching {arguments.script} (Ctrl+C to stop)")
    while True:
        modification_time = os.path.getmtime(arguments.script)
        if modification_time != last_modification_time:
            last_modification_time = modification_time
            _build_script_file(client, arguments)
        time.sleep(WATCH_POLL_INTERVAL_IN_SECONDS)


def _print_new_key(client, arguments):
    print(f"export BISCAD_KEY={client.create_key(arguments.email)['api_key']}")


def _save_render(client, arguments):
    highlighted_ids = [entity_id for entity_id in arguments.highlight.split(",") if entity_id]
    with open(arguments.out, "wb") as output_file:
        output_file.write(client.render(arguments.version, arguments.view, labels=arguments.labels,
                                        highlight=highlighted_ids))
    print(arguments.out)


def _save_export(client, arguments):
    output_path = arguments.out or f"{arguments.version}.{arguments.format}"
    with open(output_path, "wb") as output_file:
        output_file.write(client.export(arguments.version, arguments.format))
    print(output_path)


COMMAND_HANDLERS = {
    "key": _print_new_key,
    "me": lambda client, arguments: print(json.dumps(client.me(), indent=2)),
    "build": _build_script_file,
    "watch": _watch_script_file,
    "render": _save_render,
    "export": _save_export,
    "measure": lambda client, arguments: print(json.dumps(client.measure(arguments.version, arguments.a, arguments.b), indent=2)),
    "check": lambda client, arguments: print(json.dumps(client.check(arguments.version, arguments.process), indent=2)),
    "diff": lambda client, arguments: print(json.dumps(client.diff(arguments.a, arguments.b), indent=2)),
    "topology": lambda client, arguments: print(json.dumps(client.topology(arguments.version), indent=1)),
}


def _add_build_command(subcommands, command_name, help_text):
    build_command = subcommands.add_parser(command_name, help=help_text)
    build_command.add_argument("script")
    build_command.add_argument("-p", "--param", action="append", help="override a param: name=value")
    build_command.add_argument("--quality", default="normal", choices=["draft", "normal", "fine"])
    for output_flag in ("--step", "--stl", "--glb"):
        build_command.add_argument(output_flag)
    build_command.add_argument("--3mf", dest="tmf")
    build_command.add_argument("--png")


def _add_command(subcommands, command_name, help_text, *positional_names, **options_with_defaults):
    command = subcommands.add_parser(command_name, help=help_text)
    for positional_name in positional_names:
        is_optional = positional_name.endswith("?")
        command.add_argument(positional_name.rstrip("?"), **({"nargs": "?"} if is_optional else {}))
    for option_flags, option_settings in options_with_defaults.items():
        command.add_argument(*option_flags.split("|"), **option_settings)


def build_argument_parser():
    parser = argparse.ArgumentParser(prog="biscad", description="BISCAD CLI")
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--key", default=None)
    subcommands = parser.add_subparsers(dest="cmd", required=True)
    _add_command(subcommands, "key", "create a free API key", "email")
    subcommands.add_parser("me", help="plan and usage")
    _add_build_command(subcommands, "build", "build a build123d script")
    _add_build_command(subcommands, "watch", "rebuild on every save")
    _add_command(subcommands, "render", "render a version to PNG", "version", **{
        "--view": {"default": "iso"}, "--labels": {"action": "store_true"}, "--highlight": {"default": ""},
        "-o|--out": {"default": "render.png"}})
    _add_command(subcommands, "export", "download a version", "version", "format", **{"-o|--out": {}})
    _add_command(subcommands, "measure", "measure one or two refs", "version", "a", "b?")
    _add_command(subcommands, "check", "manufacturability check", "version", **{"--process": {"default": "fdm"}})
    _add_command(subcommands, "diff", "geometric diff of two versions", "a", "b")
    _add_command(subcommands, "topology", "faces and edges with ids", "version")
    return parser


def main(argv=None):
    arguments = build_argument_parser().parse_args(argv)
    client = Client(arguments.api, arguments.key)
    try:
        return COMMAND_HANDLERS[arguments.cmd](client, arguments) or 0
    except BISCADError as client_error:
        print(f"error: {client_error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
