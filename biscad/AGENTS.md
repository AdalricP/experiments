# BISCAD — agent guide

Read this file, `.construction/*.md` and `PROGRESS.md` before you change anything.
The `.construction` rules are absolute for new and touched code (snake_case, full-meaning names,
zero comments except the one signature, nesting depth ≤ 3, pure core / effects at the edge).
Prose follows `.construction/how-to-write-prose.md` (80% ASD-STE100).

## What BISCAD is
An AI-native CAD kernel as a service: build123d / OpenCascade behind a REST API and an MCP server,
a dark Blender-grade web studio and viewer, and outputs made for humans to oversee agents (stable
face ids, renders agents can see, build-step replay, design reports). Onshape's API, rebuilt from
first principles and priced per build instead of per seat. Sibling of Voncad (the terminal viewer;
never touch the Voncad repo).

## Budgets and rules
- Total lines of code stay well under 100k. Fewer lines beat more features. Delete before adding.
- Never spend the user's money. No purchases, no paid tiers, no card-required services. Free tiers
  and existing credits only. Autoscaling deploys must cap max instances.
- Never post publicly. Marketing launches only from the passphrase-gated launch console, by the user.
- The experiments repo is public. Never commit anything from AutoWell/Ottovel (a private project).
- Every change: run `python -m pytest -q tests` (from `biscad/`), commit, push to the session branch.

## Brand
Name: BISCAD (all caps in the wordmark). Palette and logo: `brand/` (blood red on near-black).
UI references: Blender, Fusion 360. Anti-references: Onshape, FreeCAD, OpenSCAD.

## Notifying the user (they are asleep)
- Phone: the PushNotification tool. Laptop: write `{kind, message, at}` to the bell artifact
  (https://claude.ai/artifact/HDaHXBQzuRUXenwXzMM41V, collection `bell`, doc `status`;
  kind ∈ done | help-needed | credits-needed | stopped). Tones live in `bell/`.
- Ping only for: done, help needed, credits needed, stopped.

## Resuming
An hourly trigger wakes the build session. Pick the next unchecked item in `PROGRESS.md`.
