# Voncad Cloud

**The CAD kernel for agents.** build123d / OpenCascade as a REST API and an MCP server, with a
web CAD viewer, a studio, and outputs built for humans to oversee what agents make. Sibling of
Voncad (the terminal viewer). Priced per build, not per seat — an agent can iterate hundreds of
times an hour for cents, instead of burning an annual Onshape API allowance in an afternoon.

## Run it (pick one)

```bash
cd voncad-cloud

# 1. Public URL from your laptop, no account needed (Cloudflare quick tunnel)
VONCAD_ADMIN_KEY=vc_pick_a_secret ./deploy/public.sh

# 2. Free permanent hosting on Hugging Face Spaces (2 vCPU / 16 GB, no card)
#    token: https://huggingface.co/settings/tokens (write access)
HF_TOKEN=hf_xxx VONCAD_ADMIN_KEY=vc_pick_a_secret ./deploy/huggingface.sh <your-hf-username>

# 3. Plain local dev
pip install -r server/requirements.txt
cd server && VONCAD_ADMIN_KEY=vc_pick_a_secret uvicorn app:app --port 8000
# → http://localhost:8000  (landing)  /studio.html  /docs.html  /api/docs  /mcp

# 4. Docker anywhere (Fly, Railway, a VPS…)
docker build -t voncad-cloud . && docker run -p 8000:8000 -v voncad:/data voncad-cloud
```

Render.com: New → Blueprint → this repo (uses `/render.yaml`; free plan sleeps when idle).

Optional: set `ANTHROPIC_API_KEY` on the server to enable **text-to-CAD** (`POST /v1/agent`, the
studio's Ask box). Each run spends your Anthropic credits, so it requires an API key and is capped
per plan (`VONCAD_FREE_AGENT_RUNS`, default 10/month on the free plan).

## Use it

```bash
# MCP (Claude Code / Desktop / Cursor)
claude mcp add --transport http voncad https://<host>/mcp

# CLI / SDK (stdlib only)
export VONCAD_API=https://<host>
python client/voncad.py key you@example.com          # → export VONCAD_KEY=vc_...
python client/voncad.py build part.py --step part.step --png part.png -p width=80
python client/voncad.py watch part.py --step part.step   # rebuild on save; open part.step in Voncad
```

## What's in it

| | |
|---|---|
| **Kernel** | build123d 0.13 on OpenCascade, every job in a forked, rlimited worker (~0.2 s for simple parts) |
| **Stable references** | every face/edge/vertex is `p0/f3`, `p0/e7`, … — same ids in the viewer, REST and MCP |
| **Agents can see** | `render.png` (any view, id labels, highlights), 4-view `render-grid.png`, MCP tools return images |
| **Oversight** | build-step replay with plain-English (STE-style) descriptions, HTML design report, explainer GIF |
| **Parametric** | top-level `params = {...}` in a script → overridable per build → configurations |
| **Versioned** | documents → versions with parents (branch from anywhere), geometric diff between any two |
| **Analysis** | measure (distance/angle/parallel), section (area + hatched SVG), mass/CoM/inertia, DFM (fdm/cnc/sheet) |
| **Exchange** | export STEP, STL, GLB, 3MF, BREP, OBJ, SVG/DXF 3-view drawings; import STEP/BREP/STL |
| **Text-to-CAD** | `POST /v1/agent`: Claude writes → kernel builds → Claude checks renders → fixes (optional) |
| **Web** | landing, studio (editor + params + viewer + tools), embeddable viewer, docs |
| **Accounts** | API keys, plans, monthly quotas, rate limits, usage metering (SQLite) |

## Layout

```
server/   app.py (REST) · mcp_server.py · core.py · kernel.py (sandbox) · tessellate.py · render.py
          steps.py · analysis.py · explainer.py · agent.py · store.py · examples.py
web/      index.html · studio.html · view.html · docs.html · llms.txt · js/ css/ samples/ assets/
client/   voncad.py (CLI + Python SDK)
deploy/   public.sh · huggingface.sh · huggingface/README.md       (+ Dockerfile, ../render.yaml)
tests/    test_api.py (python -m pytest -q tests)
```

## Security notes

Scripts are untrusted Python. Defences: AST guard (import allowlist, no dunders, no I/O or
introspection names), scripts only ever see sanitized copies of modules, no file writes while
user code runs (RLIMIT_FSIZE), CPU/memory/time limits per forked job, server code read-only to the
runtime user in Docker. This is best-effort; for a large public deployment also run the
container under gVisor or Firecracker. Version ids are unguessable capability links; documents
are private to their owner's key.

## Not done yet

- Payments: the Pro/Scale tiers on the landing page are copy only; no billing is wired up
  (nothing was purchased or signed up for).
- Hugging Face free storage is ephemeral (documents reset when the Space restarts) unless you
  add persistent storage or point `VONCAD_DATA` at a volume.
