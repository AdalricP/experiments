# ⚔ Arcanum Field

*A rough experiment, not a polished project — see the repo's AGENTS.md.*

A 2-player, Wizard-of-Legend-flavored pixel duel on an open field — where **both
players are LLMs**. Each model authors its own spellbook (JavaScript
incantations) and its own control policy, then the game runs the fight.

## Play

```sh
cd wizard-arena
python3 -m http.server 8631     # or: npx serve
# open http://localhost:8631
```

No build step. The two wizards installed in `wizards/` are the **Season 1
finalists** — battle-hardened over a 10-generation agent-vs-agent tournament
(see below). A server is needed because the game uses ES modules, which
browsers block on `file://`.

## The rules the LLMs play under

- Identical stats: 100 HP / 100 mana / 100 stamina (duels open at 60 mana),
  identical regen. Sudden death at 180 s favors the healthier wizard.
- **Max 4 spells.** A spell is a JS incantation priced *structurally*:
  base + per-character + **0.8 mana per `if`** + **2.5 per loop** + 0.6 per
  primitive call. A pricier spell gets a proportionally bigger power budget —
  verbosity literally is power (comments count).
- **Elements**: fire ▶ air ▶ earth ▶ water ▶ fire, light ⇄ dark. Each wizard
  declares a public affinity (15% discount on matching spells); damage
  multiplies ×1.3 / ×0.75 / ×0.8 against the defender's affinity.
- **Primitives** (magical spend the cast's budget; physical spend stamina):
  `bolt` (speed and homing both priced), `nova` (unmissable, radius-floored
  pricing), `heal` (diminishing returns — no cap, but efficiency =
  1/(1+recent/8)), `shield`, `blink`, `haste`, `curse` (DoT), `slow`,
  `sacrifice` (blood → power), `swap`, `push`/pull, `reflect`, `rune`
  (visible traps), `leech` (lifesteal), `strike` (melee, half-pierces
  shields), `lunge`.
- **Policy** = a JS function body run every 0.25 s (move, cast, dodge via
  `api.threats`, avoid traps via `api.hazards`, persistent `memory`).
  Stamina cost per tick is structural too, capped at 4. Bottom out your
  stamina and you go **winded**: policy suspended, 45% speed, HP and mana
  bleeding until stamina refills to full. Exhaustion can kill.
- LLM code runs through a loop-guarded sandbox (crash-safe, not security).

The full canonical rulebook lives in `forge-common.mjs` (single source of
truth sent to every wizard-authoring model).

## Season 1 — the agent tournament

Two Claude subagents ("Smith-A" and "Smith-B") designed wizards from a blank
rulebook — no example spells, never seeing each other's code, only battle
logs — and iterated over 10 generations. The referee ran 9 headless matches
per generation (`tourney.mjs`); every cast of all 90 matches is logged in
`fights/gen-01..10.log`, with the season narrative in `fights/history.md`.

**Champion: Maelketh, the Riptide Executioner (Smith-B), 7 generations to 3.**

| Gen | Winner | Score | How |
|---|---|---|---|
| 1 | Maelketh | 9–0 | Mirror burst race, 2-second kills |
| 2 | Pyrrhax | 8–1 | Earth counter-pick; B's dodge-loop bug starved its own offense |
| 3 | Maelketh | 9–0 | "Predatory" priority inversion — tempo kills at t≈4 |
| 4 | Pyrrhax | 5–4 | Drag-into-nova execute vs hardened alpha; first close gen |
| 5 | Maelketh | 9–0 | Band discipline: 116 px execute out-ranged the 105 px trigger |
| 6 | Pyrrhax | 9–0 | Blink-extended 150 px Verdict beat the 135 px hold band |
| 7 | Maelketh | 9–0 | The clock beat the reach: Rend at t≈1.25 vs Verdict arm at t≈1.5 |
| 8 | Maelketh | 9–0 | Built to win the mutual trade — armored crossing ate the tick-one alpha |
| 9 | Maelketh | 9–0 | Dual-mode: unreflectable curse rotted A's fortress; series clinched |
| 10 | Maelketh | 9–0 | Championship build swept the exhibition |

The meta evolved on its own: burst races → elemental counter-picks →
policy-priority economics → a pixel-measured range arms race
(105 → 116 → 135 → 150 → 204 px) → opening-clock warfare in quarter-second
ticks → trade-math engineering → siege vs siege-breaking. Along the way the
agents exploited the small-nova pricing discount (patched mid-season),
tilde-padded comments to buy power budget (legal — that's the mechanic),
golfed policies into ternaries to dodge the per-`if` stamina tax, and built
mock opponents to spar against — gen 10's lesson being that Smith-A's mock of
Maelketh lost 1–14 to A's finale build while the *real* Maelketh won 9–0.

## Forge new challengers

Any LLM can author a wizard — the forge sends the full rulebook and writes a
drop-in wizard file.

**Via OpenRouter** (any model, no Anthropic API needed; plain `fetch`, no
install):

```sh
export OPENROUTER_API_KEY=sk-or-...   # https://openrouter.ai/keys
node author-openrouter.mjs --style "a paranoid lightning hermit" --model openai/gpt-4o        --out wizards/ember.js
node author-openrouter.mjs --style "a greedy void cultist"       --model google/gemini-2.5-pro --out wizards/frost.js
```

**Via the Anthropic API** (needs platform.claude.com credits — a Claude.ai
subscription does not include API access): `npm install` then
`node author.mjs --style "..." --out wizards/ember.js`.

**Headless referee tools** (what ran the tournament):

```sh
node tools/validate.mjs my-wizard.json          # compile + cost + dry-run check
node tourney.mjs a.json b.json --matches 9 --log fights/my-match.log
```

## Files

- `index.html`, `style.css` — page shell, HUD panels, battle feed
- `src/rules.js` — every number in the rulebook, one place
- `src/sandbox.js` — loop-guarded compiler for LLM code
- `src/engine.js` — simulation: budgets, elements, winded, traps, the lot
- `src/render.js` — pixel-art field, wizards, particles, screen shake
- `forge-common.mjs` — the canonical rulebook + wizard schema
- `wizards/` — the installed combatants (Season 1 finalists)
- `arena-lab/` — the smiths' working files from the tournament
- `fights/` — all 90 match logs + `history.md` season narrative
- `author.mjs` / `author-openrouter.mjs` — LLM wizard forges
- `tourney.mjs`, `tools/validate.mjs` — referee tooling
