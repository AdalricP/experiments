from __future__ import annotations

import base64
import os
import re

import anthropic

import core
import render
import store
from mcp_server import GUIDE

MODEL = os.environ.get("BISCAD_AGENT_MODEL", "claude-opus-5-5")
MAX_ROUNDS = int(os.environ.get("BISCAD_AGENT_ROUNDS", "4"))
MAX_REPLY_TOKENS = 16000
MAX_STEPS_SHOWN_TO_MODEL = 30
REVIEW_GRID_TILE_SIZE_IN_PIXELS = 380

SYSTEM_PROMPT = GUIDE + """

You are BISCAD's CAD engineer. You write complete build123d programs.
Rules for every reply that contains a program:
- Reply with exactly one ```python fenced block holding the whole program, then at most two
  sentences on what you changed. No other code blocks.
- Put every dimension a user might tune in the top-level `params = {...}` dict.
- Prefer BuildPart builder mode; keep the program under ~150 lines; millimetres; Z up.
When you are shown renders of your build: check the geometry against the request (proportions,
feature count, placement, holes going through, nothing floating). If it is correct, reply with
the single word DONE. Otherwise reply with the corrected full program.
"""

_anthropic_client = None


def is_available() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    return os.path.isdir(os.path.expanduser("~/.config/anthropic"))


def anthropic_client():
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = anthropic.Anthropic()
    return _anthropic_client


def ask_model_for_reply(messages: list) -> str:
    try:
        response = anthropic_client().beta.messages.create(
            model=MODEL, max_tokens=MAX_REPLY_TOKENS, system=SYSTEM_PROMPT, messages=messages,
            output_config={"effort": "medium"}, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    except anthropic.RateLimitError:
        raise core.ApiError(429, "the AI model is rate limited, retry shortly", "agent_rate_limited")
    except anthropic.AuthenticationError:
        raise core.ApiError(501, "the server's Anthropic credentials are invalid", "agent_unavailable")
    except anthropic.APIStatusError as status_error:
        raise core.ApiError(502, f"AI model error ({status_error.status_code})", "agent_error")
    except anthropic.APIConnectionError:
        raise core.ApiError(502, "could not reach the AI model", "agent_error")
    if response.stop_reason == "refusal":
        raise core.ApiError(422, "the AI model declined this request", "agent_refused")
    return "".join(block.text for block in response.content if block.type == "text").strip()


def extract_python_program(reply_text: str) -> str | None:
    program_match = re.search(r"```(?:python|py)?\s*\n(.*?)```", reply_text, re.S)
    return program_match.group(1).strip() + "\n" if program_match else None


def _image_content_block(png_bytes: bytes) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                         "data": base64.standard_b64encode(png_bytes).decode()}}


def _first_request_message(prompt: str, base_script: str | None) -> dict:
    request_text = f"Request: {prompt.strip()}"
    if base_script:
        request_text += f"\n\nModify this existing program to satisfy the request:\n```python\n{base_script}\n```"
    return {"role": "user", "content": request_text}


def _build_failure_message(version: dict) -> dict:
    return {"role": "user", "content": f"The build failed:\n{version['error']}\n{(version.get('logs') or '')[-1500:]}\nFix it."}


def _review_request_message(version: dict) -> dict:
    summary = version["summary"]
    lowest, highest = summary["bbox"]["min"], summary["bbox"]["max"]
    facts = (f"Built OK: {len(summary['parts'])} part(s), size {highest[0]-lowest[0]:.1f} × {highest[1]-lowest[1]:.1f} × "
             f"{highest[2]-lowest[2]:.1f} mm, volume {summary['volume']:,.0f} mm³, "
             f"faces {sum(part['faces'] for part in summary['parts'])}.\n"
             "Steps:\n" + "\n".join(f"{step['index'] + 1}. {step['description']}"
                                    for step in version["steps"][:MAX_STEPS_SHOWN_TO_MODEL]))
    grid_png = render.render_four_view_grid_png(store.directory_for_version(version["id"]), REVIEW_GRID_TILE_SIZE_IN_PIXELS)
    return {"role": "user", "content": [
        _image_content_block(grid_png),
        {"type": "text", "text": facts + "\n\nIso, front, top and right views are above. "
                                         "Reply DONE if this matches the request, otherwise the corrected program."},
    ]}


def _build_round_program(caller: dict, document_id: str | None, program: str, parent: str | None, prompt: str) -> dict:
    message = f"agent: {prompt[:80]}"
    if document_id:
        return core.build_new_document_version(caller, document_id, program, None, parent, message)
    return core.build_version(caller, program, None, None, parent, message)


def run_text_to_cad(caller: dict, prompt: str, base_script: str | None = None, document_id: str | None = None) -> dict:
    if not prompt or not prompt.strip():
        raise core.ApiError(400, "prompt is required")
    if not is_available():
        raise core.ApiError(501, "text-to-CAD is not configured on this server (set ANTHROPIC_API_KEY)", "agent_unavailable")
    messages = [_first_request_message(prompt, base_script)]
    rounds, last_successful_version, parent = [], None, None
    for _round_number in range(MAX_ROUNDS):
        reply = ask_model_for_reply(messages)
        messages.append({"role": "assistant", "content": reply})
        if reply.strip().upper().startswith("DONE") and last_successful_version:
            break
        program = extract_python_program(reply)
        if not program and last_successful_version:
            break
        if not program:
            messages.append({"role": "user", "content": "Reply with the full program in one ```python block."})
            continue
        note = re.sub(r"```.*?```", "", reply, flags=re.S).strip()[:400]
        version = _build_round_program(caller, document_id, program, parent, prompt)
        rounds.append({"version_id": version["id"], "ok": version["ok"], "error": version.get("error"), "note": note})
        parent = version["id"]
        last_successful_version = version if version["ok"] else last_successful_version
        messages.append(_review_request_message(version) if version["ok"] else _build_failure_message(version))
    if not last_successful_version:
        return {"ok": False, "version": None, "rounds": rounds,
                "error": rounds[-1]["error"] if rounds else "the model did not produce a program"}
    return {"ok": True, "version": core.public_view_of_version(store.get_version(last_successful_version["id"])),
            "rounds": rounds}
