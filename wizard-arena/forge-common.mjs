// Shared between author.mjs (Anthropic API) and author-openrouter.mjs.
import { writeFileSync } from "node:fs";

export const SYSTEM_PROMPT =
  "You are a champion game-AI designer competing in a wizard-dueling league. " +
  "You write tight, correct, plain JavaScript and you play to win.";

export const RULEBOOK = `
You are designing a duelist for ARCANUM FIELD, a 2-player wizard battler on an
open field. Your opponent is another LLM's wizard. Both wizards have IDENTICAL
stats — only your 4 spells and your policy script differ. Win by design.

STATS (both players): 100 HP, 100 mana (BUT each duel opens at 60 mana —
regen carries you to full; no turn-zero alpha strike), 100 stamina.
Regen per second: 0.6 HP, 7 mana, 12 stamina.
Move speed 62 px/s. Arena is a rectangle {x:24,y:46,w:432,h:200}.

ELEMENTS — pick ONE affinity for your wizard ("element" field: fire, water,
earth, air, light, or dark) and give each spell an "element" field (one of
those, or "neutral"). The wheel: fire▶air▶earth▶water▶fire, light⇄dark
("▶" = strong against). Damage multipliers apply against the DEFENDER'S
AFFINITY: strong ×1.3, weak ×0.75, same-element ×0.8 (attunement resists its
own element), neutral always ×1.0. Spells matching YOUR affinity cost ×0.85
mana. Mono-element is efficient but counterable; neutral is safe but gets no
discount. Your affinity is visible to the enemy (snapshots carry .element).

SPELLS — you write up to 4. Each spell is a JavaScript incantation (a function
body, args: ctx, me, enemy). Spells are priced STRUCTURALLY, as a composition
of parts:
  MANA COST = 4  +  0.04/character  +  0.8 per "if("  +  2.5 per "for("/"while("
              +  0.6 per ctx.* call site   (then ×0.85 if affinity-matched)
A pricier spell gets a bigger power budget: budget = manaCost × 2.2 "power
units". Every MAGICAL primitive spends budget when it runs; when the budget
runs out, further calls silently fail. PHYSICAL primitives spend your STAMINA
instead (see below) — they're free on budget but feed the winded mechanic.
Per-spell cooldown 0.8s, global cooldown 0.35s. Max 900 chars.

Incantation API (ctx):
  ctx.aim                  angle (radians) toward the cast target (enemy by default)
  ctx.dist                 current distance to enemy (px)
  ctx.budget()             remaining power units
  ctx.rand()               random [0,1)
 magical (spend budget):
  ctx.bolt(angle, {damage, speed, radius, homing})
      damage 1–30, speed 40–260, radius 1.5–5. Carries the spell's element.
      price: dmg × (0.7 + 0.6×speed/260), ×1.6 if homing — SPEED COSTS:
      a 260-speed bolt runs ×1.3, a 130-speed bolt ×1.0, a 40-speed lob ×0.79.
      Homing turns at only 1.2 rad/s and can be outrun at close range.
  ctx.nova(damage, radius) instant AoE centered on YOU — cannot miss. dmg 1–30,
      radius 15–70. price: dmg × 1.4 × (max(radius,40)/40) — novas never get
      cheaper than the r=40 rate; tiny novas are a reach tradeoff, not a
      discount. Carries the element.
  ctx.heal(hp)             price 1.8 per HP GRANTED. Diminishing returns:
      granted = request / (1 + recentHealing/8), recentHealing decays 3/s.
      No hard cap — but spam-healing gets exponentially less efficient.
  ctx.shield(hp)           price 1.4/HP, max 40 shield, decays 6/s
  ctx.blink(dx, dy)        teleport, price 0.15/px, max 120 px, clamped to arena
  ctx.haste(pct, seconds)  move-speed buff, price 0.06 × pct × seconds
  ctx.curse(dps, seconds)  damage over time on the enemy, price 1.2 × total dmg.
      dps ≤6, ≤6s. Carries the element; ticks every 0.5s.
  ctx.slow(pct, seconds)   slow the enemy's movement, price 0.07 × pct × sec.
      ≤50%, ≤4s. Doesn't stack — strongest wins.
  ctx.sacrifice(hp)        BLOOD MAGIC: burn your OWN HP for +3 power units per
      HP, mid-cast. ≤25 HP per cast; cannot take you below 5 HP. The cheapest
      power in the game — priced in blood.
  ctx.swap()               trade positions with the enemy. Flat 20 power.
  ctx.push(px)             displace the enemy along the line between you:
      positive shoves them away, NEGATIVE DRAGS THEM TOWARD YOU (into novas,
      strikes, runes…). ≤60px, price 0.35/px.
  ctx.reflect(seconds)     mirror ward: incoming bolts bounce back at their
      caster as YOUR projectiles. 0.3–2s, price 12/s. Hard-counters bolt spam.
  ctx.rune(x, y, dmg, radius, armSec)  plant a trap at (x,y): after armSec
      (0.4–3s) it detonates on enemy contact. dmg ≤25, radius 15–50, fades
      after 8s, max 3 active. price: dmg × 1.1 × (max(radius,40)/40). VISIBLE
      to the enemy (their policy sees api.hazards) — placement is prediction.
  ctx.leech(pct, seconds)  lifesteal: pct% (≤40) of damage you deal heals you
      for the duration (≤4s), through the diminishing-returns curve.
      price 0.12 × pct × sec.
 physical (spend STAMINA, not budget — element-neutral):
  ctx.strike(damage)       melee hit, only lands within 26px. dmg ≤18,
      costs 1.1 stamina/dmg. IGNORES HALF the enemy's shield.
  ctx.lunge(angle, px)     instant dash ≤55px, 0.3 stamina/px. Cheap mobility,
      but stamina spent here brings you closer to WINDED.
me / enemy snapshots: {x, y, hp, mana, stamina, shield, element, winded,
slowed, reflecting} (me also has cooldowns[] and spellCosts[]).
Loops are allowed but guarded (~20k iterations max). No async, no DOM, no
imports. Plain ES5-ish JavaScript statements only.

POLICY — one JavaScript function body (args: api, me, enemy, arena, memory)
that runs every 0.25s and controls your wizard. It is priced structurally too:
  STAMINA COST PER TICK = min(4, 0.9 + 0.0022/char + 0.06 per "if(" + 0.2 per loop)
Max 4000 chars. Stamina regens 12/s (= 3.0 per tick), so keep the tick cost
under 3.0 to run forever — and remember physical primitives (strike/lunge)
ALSO drain the same stamina pool.

WINDED — if your stamina falls to 8 or below, you are WINDED until it refills
ALL THE WAY to 100: your policy STOPS running (you drift in your last movement
direction, unable to cast or decide), you move at 45% speed, and you BLEED
0.5 HP/s and 2 mana/s the whole time. Exhaustion can kill you. A fat policy is
a real liability — budget characters ruthlessly. (me.winded is in snapshots.)

Policy API:
  api.move(dx, dy)   set movement direction (auto-normalized); persists between ticks
  api.stop()
  api.cast(i)        cast spell i at the enemy   |  api.cast(i, x, y) at a point
  api.rand(), api.time
  api.threats        incoming enemy projectiles, sorted nearest-first:
      [{x, y, dx, dy, speed, damage, homing, dist}] — dx/dy is a unit direction.
      Dodging is a skill: strafe perpendicular to a threat's velocity, or blink.
      Homing bolts turn at only 1.2 rad/s — sharp sidesteps at close range beat them.
  api.hazards        enemy trap runes, nearest-first: [{x, y, r, armed, dist}].
      Walk around them — or bait the enemy through their own field.
  memory             plain object that persists across ticks — use it for state
me snapshot adds cooldowns[] and spellCosts[]; arena = {x,y,w,h}.
Casting silently fails if on cooldown or short on mana — check
me.cooldowns[i] <= 0 && me.mana >= me.spellCosts[i] yourself.

STRATEGY NOTES: point-blank novas cannot miss. Straight bolts are dodgeable —
lead your target from the policy via api.cast(i, x, y). Physical strikes
half-pierce shields and cost no mana, but burn the stamina that keeps you from
going winded. The elemental wheel is asymmetric information warfare: you can
read enemy.element and they can read yours. Sudden death at 180s favors
whoever has more HP. Corners are death; drift centerward.

Return a wizard with a memorable name, a one-line epithet, two hex colors
(color = dominant, color2 = bright accent), an affinity "element", and 1–4
spells (each with its own "element" field), plus the policy.
Make the design COHERENT: spells and policy should express one strategy.
`;

export const WIZARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "epithet", "color", "color2", "element", "spells", "policy"],
  properties: {
    name: { type: "string" },
    epithet: { type: "string" },
    color: { type: "string", description: "hex like #ff6b3d" },
    color2: { type: "string", description: "brighter accent hex" },
    element: { type: "string", enum: ["fire", "water", "earth", "air", "light", "dark"] },
    spells: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "desc", "element", "incantation"],
        properties: {
          name: { type: "string" },
          desc: { type: "string" },
          element: { type: "string", enum: ["fire", "water", "earth", "air", "light", "dark", "neutral"] },
          incantation: { type: "string", description: "JS function body using ctx/me/enemy" },
        },
      },
    },
    policy: { type: "string", description: "JS function body using api/me/enemy/arena/memory" },
  },
};

export function parseArgs(argv) {
  return Object.fromEntries(
    argv.join(" ").split("--").filter(Boolean)
      .map((s) => { const i = s.indexOf(" "); return [s.slice(0, i > 0 ? i : undefined).trim(), i > 0 ? s.slice(i).trim() : true]; })
  );
}

// Pull a JSON object out of a model reply that may include prose or fences.
export function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model reply");
  return JSON.parse(body.slice(start, end + 1));
}

export function saveWizard(wiz, out, forgedBy, brief) {
  wiz.spells = (wiz.spells || []).slice(0, 4);
  const file = `// Forged by ${forgedBy} on ${new Date().toISOString()}
// Brief: ${String(brief).replace(/\n/g, " ")}
window.WIZARDS.push(${JSON.stringify(wiz, null, 2)});
`;
  writeFileSync(out, file);
}

export function summarize(wiz, out) {
  console.log(`\n⚔  ${wiz.name} — ${wiz.epithet}`);
  for (const s of wiz.spells) {
    const cost = Math.round((4 + 0.06 * s.incantation.length) * 10) / 10;
    console.log(`   ✦ ${s.name} (${s.incantation.length} chars → ${cost} mana): ${s.desc}`);
  }
  const tick = Math.min(4, 0.4 + 0.002 * wiz.policy.length).toFixed(2);
  console.log(`   ☰ policy: ${wiz.policy.length} chars → ${tick} stamina/tick`);
  console.log(`Written to ${out}. Serve the folder and open the page to duel.`);
}
