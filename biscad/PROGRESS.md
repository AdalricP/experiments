# BISCAD — build log / resume file

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

## Status checklist (BISCAD phase, started 20:00 UTC)
Earlier phase (backend, MCP, viewer, studio, tests) is done; see git history.
- [x] purge AutoWell material from public repo + history; rename to BISCAD
- [x] AGENTS.md, .construction rules, brand tokens, overnight bell (artifact + 4 tones in bell/)
- [x] hourly keep-working trigger; Cloud Run autoscaling deploy script
- [x] brand: logo (white/blood-red/white band, cropped B and D), BRAND.md, CAMPAIGN.md (agent)
- [x] campaign.html gallery + launch.html passphrase console (agent; passphrase file is gitignored)
- [x] landing + docs: dark blood-red, layered CC0 Poly Haven textures, new surface.js (agent)
- [x] studio + viewer: Blender-grade dark UI (follow-ups: dark agent-view render, real wordmark in header)
- [x] server: .construction style + fewer LOC, behaviour identical (agent)
- [x] docs/HANDBOOK.md technical handbook (12k words, 9 figures)
- [x] handbook PDF: docs/BISCAD-handbook.pdf (36 pages); Google Doc skipped (offer to user)
- [x] JS style/LOC pass (-208 LOC, flow test clean); kernel perf (renders 1.5-2.7x faster, outputs identical)
- [x] final integration check (41 tests, studio flow vs live server, no errors), preview artifact https://claude.ai/artifact/PxrByvS6GQ6Z8tCTfvd4pu, pinged user
- [x] persistent face ids p0/#hash (46 tests)
- [ ] next: DFM issue refs as persistent ids; sketch + constraint solver, assembly mates, shell scripts/CSS to .construction style
Project size: ~11.1k lines (excl. vendor).
