"""Text-to-CAD: describe a part, Claude writes the build123d program, the kernel builds it,
Claude looks at the renders and fixes what's wrong. Optional: needs ANTHROPIC_API_KEY on the
server (or an `ant auth login` profile). Without it, /v1/agent returns 501.

The loop is ours, not a tool runner: write -> build -> (error? feed it back) -> render grid ->
"is this right?" -> fix, up to MAX_ROUNDS. Every round is a real version, so the user can scrub
through the agent's attempts.
"""
from __future__ import annotations

import base64
import os
import re

import core
import render as R
import store
from mcp_server import GUIDE

MODEL = os.environ.get("BISCAD_AGENT_MODEL", "claude-opus-5-5")
MAX_ROUNDS = int(os.environ.get("BISCAD_AGENT_ROUNDS", "4"))

SYSTEM = GUIDE + """

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

_client = None


def available() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    return os.path.isdir(os.path.expanduser("~/.config/anthropic"))


def client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic()
    return _client


def _ask(messages):
    """One model turn. Returns the reply text."""
    import anthropic
    try:
        resp = client().beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            messages=messages,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.RateLimitError:
        raise core.ApiError(429, "the AI model is rate limited, retry shortly", "agent_rate_limited")
    except anthropic.AuthenticationError:
        raise core.ApiError(501, "the server's Anthropic credentials are invalid", "agent_unavailable")
    except anthropic.APIStatusError as e:
        raise core.ApiError(502, f"AI model error ({e.status_code})", "agent_error")
    except anthropic.APIConnectionError:
        raise core.ApiError(502, "could not reach the AI model", "agent_error")
    if resp.stop_reason == "refusal":
        raise core.ApiError(422, "the AI model declined this request", "agent_refused")
    return "".join(b.text for b in resp.content if b.type == "text").strip()


def extract_code(text: str) -> str | None:
    m = re.search(r"```(?:python|py)?\s*\n(.*?)```", text, re.S)
    return m.group(1).strip() + "\n" if m else None


def _img_block(png: bytes):
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                         "data": base64.standard_b64encode(png).decode()}}


def run(who: dict, prompt: str, base_script: str | None = None, document_id: str | None = None) -> dict:
    """-> {ok, version, rounds:[{version_id, ok, error, note}], final_note}"""
    if not prompt or not prompt.strip():
        raise core.ApiError(400, "prompt is required")
    if not available():
        raise core.ApiError(501, "text-to-CAD is not configured on this server (set ANTHROPIC_API_KEY)", "agent_unavailable")
    first = f"Request: {prompt.strip()}"
    if base_script:
        first += f"\n\nModify this existing program to satisfy the request:\n```python\n{base_script}\n```"
    messages = [{"role": "user", "content": first}]
    rounds, last_ok, parent = [], None, None
    for _ in range(MAX_ROUNDS):
        reply = _ask(messages)
        messages.append({"role": "assistant", "content": reply})
        if reply.strip().upper().startswith("DONE") and last_ok:
            break
        code = extract_code(reply)
        if not code:
            if last_ok:
                break
            messages.append({"role": "user", "content": "Reply with the full program in one ```python block."})
            continue
        note = re.sub(r"```.*?```", "", reply, flags=re.S).strip()[:400]
        if document_id:
            v = core.new_version(who, document_id, code, None, parent, f"agent: {prompt[:80]}")
        else:
            v = core.build(who, code, None, None, parent, f"agent: {prompt[:80]}")
        rounds.append({"version_id": v["id"], "ok": v["ok"], "error": v.get("error"), "note": note})
        parent = v["id"]
        if not v["ok"]:
            messages.append({"role": "user", "content": f"The build failed:\n{v['error']}\n{(v.get('logs') or '')[-1500:]}\nFix it."})
            continue
        last_ok = v
        s = v["summary"]
        lo, hi = s["bbox"]["min"], s["bbox"]["max"]
        facts = (f"Built OK: {len(s['parts'])} part(s), size {hi[0]-lo[0]:.1f} × {hi[1]-lo[1]:.1f} × {hi[2]-lo[2]:.1f} mm, "
                 f"volume {s['volume']:,.0f} mm³, faces {sum(p['faces'] for p in s['parts'])}.\n"
                 "Steps:\n" + "\n".join(f"{st['index'] + 1}. {st['description']}" for st in v["steps"][:30]))
        grid = R.render_grid(store.vdir(v["id"]), 380)
        messages.append({"role": "user", "content": [
            _img_block(grid),
            {"type": "text", "text": facts + "\n\nIso, front, top and right views are above. "
                                             "Reply DONE if this matches the request, otherwise the corrected program."},
        ]})
    if not last_ok:
        return {"ok": False, "version": None, "rounds": rounds,
                "error": rounds[-1]["error"] if rounds else "the model did not produce a program"}
    return {"ok": True, "version": core.public_version(store.get_version(last_ok["id"])), "rounds": rounds}
