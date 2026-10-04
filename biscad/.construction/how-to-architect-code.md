# Four-phase planning template

Extracted and made usable from *Why Software Factories Fail* (HumanLayer). Drop into a repo as `docs/planning/TEMPLATE.md` or wire each phase as a separate agent skill.

---

## Phase 0 — Routing (do this first, it's the 80/20)

| Task shape | Process |
|---|---|
| Copy tweak, one-off script, bug with obvious repro | Oneshot to agent. No docs. |
| Small–medium feature | Phases 1+2 collapsed into a single plan doc. No slice breakdown. |
| Large feature | All four phases. |
| Large refactor | Phases 2–4. Skip product. |

Rule of thumb: run the full process only where **an agent misunderstanding intent is expensive**.

---

## Phase 1 — Product review

> Output: short doc. Two sentences or a voice-note ramble in, semi-structured spec out.

**Problem to solve**
- What is the user actually experiencing, in the user's terms?
- Who hits it, how often?

**What success looks like**
- Preferred: user outcome — "completes workflow X in less time", "reaches onboarding milestone Y earlier"
- Acceptable: error rate, latency number
- Also acceptable: "support tickets about Z stop"

**Mockups, not prose**
- Rough HTML of each affected screen. Do not describe UI in paragraphs.
- A workflow outline as JSON (steps + exit conditions) if there's control flow.

**Discipline note:** when you drift into technical detail, jot it in a parking lot and return to user experience. If a tech decision genuinely blocks a product decision, commit what you have and go do prototype research.

**Review:** author-opt-in. Pick the person who would review the PR. Walk them through this doc async before any code exists.

---

## Phase 2 — System architecture

> Output: how services, endpoints, schemas, queues and stores talk to each other. Not program internals.

**Sequence diagram**
```
sequenceDiagram
  participant UI
  participant API
  participant Service
  participant Store
  UI->>API: PUT /resources/:slug
  API->>Service: create(input)
  Service->>Store: insert resource
  Service-->>UI: 201 resource
```

**Contract / endpoint shapes**
```
PUT /api/resources/:slug
  request:  { destination: string }
  response: { resource: Resource }
```

**Data models and transformations**
```sql
CREATE TABLE resource (
  slug         TEXT PRIMARY KEY,
  destination  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- new query shapes
```

**Warning:** a clean Mermaid diagram can create false confidence that you're aligned when you aren't. Architecture heads off bad model tics but is *not sufficient* for good code.

---

## Phase 3 — Program design

> Output: the shape of the code, before any implementation. This is the phase people skip.

**Call-stack tree** (diff syntax — the interesting part is what changes)
```
 entrypoint
   runCommand
+    handleCreateResource
+      ResourceClient.create(input)
+        POST /resources
+      renderResult
-    legacyCreateFlow
```

**File-tree diff**
```
 src
 └── resource
+    ├── resource-client.ts      # NEW - wraps API contract calls
+    ├── resource-client.test.ts # NEW - request/response mapping
~    └── resource-route.ts       # MODIFIED - wires create action into UI
```

**Types and key signatures**
```ts
interface Item {
  id: ItemId
  parentId: ItemId | null
}

interface Cursor {
  position: ItemId
  direction: 'up' | 'down'
}

resolveTarget(items: Item[], cursor: Cursor): ItemId | null
```

**How to run it:** the model drafts, you argue with it. Prefer light pseudocode over Mermaid here — Mermaid was tried and abandoned as exhausting to read.

**Why it pays:** each item above is a decision you would otherwise make implicitly during code review, i.e. at the most expensive possible moment to change your mind.

---

## Phase 4 — Vertical slices

> Output: an ordered list of slices, each of which produces something you can touch.

**Anti-pattern — the horizontal plan models default to:**
```
1. Database migrations
2. Service layer
3. API
4. Frontend
```
Nothing is testable by hand until the very end.

**Pattern — start in the middle, work outward:**
1. API contract serving mock data → verify with curl
2. Frontend consuming mock data → iterate and polish in browser
3. Wire API to service layer (services still return mock behaviour)
4. Migrations, wire services to real DB
5. Business logic
6. Error handling

Test, iterate and polish at each step.

**Execution rule:** dispatch 1–3 slices at a time and review the diff as you go. Resteering 100–200 lines is cheap. Debugging 2,000 lines you've never read is not.

---

## Checklist before dispatching an agent

- [ ] Do I know what user outcome tells me this worked?
- [ ] Is there a mockup instead of a paragraph describing UI?
- [ ] Have I named the contracts and data shapes?
- [ ] Have I named the types, signatures and call stack?
- [ ] Is the work sliced so I can touch something after slice one?
- [ ] Has the eventual PR reviewer seen the plan?
- [ ] Am I prepared to read every line that comes back?

---

## Standing constraints to keep in mind

1. There is no fast oracle for maintainability, so RL never rewarded it. Agents optimise for "tests pass," not "easy to change in six months."
2. Review agents raise the floor (catch the dumb stuff). They do not move the ceiling.
3. An agent-built codebase starts fighting back around the 3–6 month mark.
4. A PR needing 20%+ rework is a tax on everyone. AI oneshots trend toward 50%.
5. Target 2–3x safely, not 10–100x with a fire behind you.
