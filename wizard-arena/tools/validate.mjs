// Validate a wizard JSON file: compiles every incantation and the policy,
// reports costs, and dry-runs one solo turn so obvious crashes surface early.
//
//   node tools/validate.mjs arena-lab/agent-a.json

import { readFileSync } from "node:fs";
import { Duel } from "../src/engine.js";
import { spellManaCost, policyStaminaCost, RULES } from "../src/rules.js";

const file = process.argv[2];
if (!file) { console.error("usage: node tools/validate.mjs wizard.json"); process.exit(1); }

let def;
try { def = JSON.parse(readFileSync(file, "utf8")); }
catch (e) { console.error(`✗ not valid JSON: ${e.message}`); process.exit(1); }

const problems = [];
if (!def.name) problems.push("missing name");
if (!Array.isArray(def.spells) || !def.spells.length) problems.push("no spells");
if (typeof def.policy !== "string" || !def.policy.trim()) problems.push("no policy");
if ((def.spells || []).length > RULES.MAX_SPELLS) problems.push(`more than ${RULES.MAX_SPELLS} spells (extras dropped)`);

const dummy = {
  name: "Sparring Post", color: "#666666", color2: "#aaaaaa",
  spells: [{ name: "poke", desc: "", incantation: "ctx.bolt(ctx.aim,{damage:2,speed:90})" }],
  policy: "api.move(enemy.x-me.x,enemy.y-me.y); if(me.cooldowns[0]<=0) api.cast(0);",
};
const logs = [];
const duel = new Duel(def, dummy, (m) => logs.push(m.replace(/<[^>]*>/g, "")));
const w = duel.wizards[0];

console.log(`— ${w.name} —`);
for (const s of w.spells) {
  const line = `spell "${s.name}": ${s.incant.length} chars → ${s.cost} mana, budget ${(s.cost * RULES.POWER_PER_MANA).toFixed(1)}`;
  if (s.compiled.error) { problems.push(`spell "${s.name}": ${s.compiled.error}`); console.log(`✗ ${line} — ${s.compiled.error}`); }
  else console.log(`✓ ${line}`);
  if (s.incant.length > RULES.MAX_INCANT_CHARS) problems.push(`spell "${s.name}" over ${RULES.MAX_INCANT_CHARS} chars (truncated!)`);
}
const tick = policyStaminaCost(w.policySrc);
const sustainable = tick <= RULES.STAMINA_REGEN * RULES.POLICY_TICK;
console.log(`${w.policy.error ? "✗" : "✓"} policy: ${w.policySrc.length} chars → ${tick.toFixed(2)} stamina/tick ` +
  `(${sustainable ? "sustainable forever" : "DRAINS stamina — winded risk!"})` +
  (w.policy.error ? ` — ${w.policy.error}` : ""));
if (w.policy.error) problems.push(`policy: ${w.policy.error}`);

// dry-run 8 simulated seconds against a sparring post
for (let t = 0; t < 8; t += 1 / 60) duel.update(1 / 60);
const runtimeIssues = logs.filter((l) => l.includes("fizzles") || l.includes("mind stutters"));
if (runtimeIssues.length) {
  console.log(`⚠ runtime issues in an 8s dry-run:`);
  for (const l of [...new Set(runtimeIssues)]) console.log(`   ${l}`);
  problems.push(`${runtimeIssues.length} runtime error(s) in dry-run`);
} else {
  console.log(`✓ 8s dry-run clean (dealt ${(100 - duel.wizards[1].hp).toFixed(0)} dmg to a sparring post)`);
}

if (problems.length) { console.log(`\nPROBLEMS: ${problems.join("; ")}`); process.exit(2); }
console.log("\nAll checks passed.");
