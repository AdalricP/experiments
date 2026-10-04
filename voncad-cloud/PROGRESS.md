# Voncad Cloud — build log / resume file

**If you are an agent resuming this work: read this file first, then `git log --oneline -20`.**
Branch: `ccr-4f21a726-l2eztr` on AdalricP/experiments. Commit + push after every milestone.

## Goal
AI-native, cheap alternative to the Onshape API: a hosted CAD kernel (build123d / OpenCascade)
behind a REST API + MCP server, plus a high-quality web CAD viewer and a landing page. Sibling of Voncad (the terminal viewer).

## Layout
- `server/` FastAPI app: kernel sandbox, tessellation, render, analysis, exports, store, auth, MCP
- `web/` static site (no build step): landing `index.html`, `studio.html`, `view.html`, `docs.html`
- `deploy/` Dockerfile, HF Spaces / Render configs, public tunnel script
- `tests/` pytest

## Scene format (server → viewer), v1
See `server/tessellate.py` docstring.

## Status checklist
(backend done 19:40 UTC; web being built by two subagents: studio/viewer and landing/docs)
Extra (user asked mid-way, Karpathy "understand LLM output" thread): build-step replay
(`steps.py`), HTML design report + explainer GIF (`explainer.py`) — done in backend.
Dev server: `cd server && VONCAD_ADMIN_KEY=vc_admin_test uvicorn app:app --port 8000`
Tests: `python -m pytest -q tests` (41 passing)
Done since: quadruped hero, text-to-CAD agent (/v1/agent, needs ANTHROPIC_API_KEY), CLI client,
sandbox hardening (escape probes are tests), interference + BOM, README + repo log entry.
Remaining: studio/viewer (subagent), publish a static preview Artifact, final report to user.

- [x] kernel sandbox (subprocess, AST guard, rlimits)
- [x] tessellation → scene JSON with stable face/edge ids
- [x] software renderer → PNG (agents can see)
- [x] analysis: mass props, measure, section, DFM, diff
- [x] exports: step stl glb 3mf brep svg dxf
- [x] store: documents, versions, params
- [x] auth: API keys, quotas, metering
- [x] REST API + OpenAPI
- [x] MCP server (/mcp)
- [x] web: landing
- [ ] web: studio + viewer
- [x] web: docs
- [x] deploy: Dockerfile + one-command public URL
- [x] tests green

## API contract v1 (base URL = same origin, or `?api=` override in web)
Auth: header `Authorization: Bearer vc_...` (optional; anonymous = playground quota by IP).
- `POST /v1/keys` `{email}` → `{api_key, plan}`
- `GET  /v1/me` → `{plan, usage:{calls_today, calls_month, compute_ms_month}, limits}`
- `POST /v1/build` `{script, params?}` → stateless build: `{ok, error?, logs, summary, scene}`
- `POST /v1/documents` `{name, script?, features?, params?, public?}` → `{document, version}`
- `GET  /v1/documents` → `{documents:[...]}` ; `GET /v1/documents/{id}` → `{document, versions}`
- `POST /v1/documents/{id}/versions` `{script?, params?, features?, parent?, message?}` → `{version}`
- `GET  /v1/versions/{vid}` → `{id, document_id, parent, script, params, param_schema, status, error, logs, summary, created}`
   summary = `{parts:[{id,name,volume,area,bbox,faces,edges,solids}], bbox, volume, area, mass_g, center_of_mass}`
- `GET  /v1/versions/{vid}/scene` → scene JSON (see server/tessellate.py)
- `GET  /v1/versions/{vid}/topology` → faces/edges descriptors without mesh
- `GET  /v1/versions/{vid}/render.png?view=iso|front|top|right|back|left|bottom&w=&h=&highlight=p0/f3,p0/e2`
- `GET  /v1/versions/{vid}/export/{fmt}` fmt ∈ step|stl|glb|3mf|brep|svg|dxf
- `POST /v1/versions/{vid}/measure` `{a:"p0/f1", b:"p0/f7"}` → `{distance, angle_deg?, a, b}`
- `POST /v1/versions/{vid}/section` `{origin:[x,y,z], normal:[x,y,z]}` → `{area, svg}`
- `GET  /v1/versions/{vid}/mass?density=7.85` (g/cm³)
- `POST /v1/versions/{vid}/check` `{process:"fdm"|"cnc"|"sheet"}` → DFM report
- `GET  /v1/diff?a={vid}&b={vid}` → `{volume_added, volume_removed, faces_added, faces_removed}`
- `POST /v1/import` multipart `file` (step/stp/brep/stl) → `{document, version}`
- `GET  /v1/examples` → `[{id,name,script}]`
- `/mcp` streamable-HTTP MCP server (tools mirror the above; render returns an image)
Params: a script may define `params = {"width": 40, ...}`; API `params` override those values
before the script runs. `param_schema` lists them (name, default, type).
