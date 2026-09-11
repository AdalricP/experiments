// Headless referee: pit two wizard JSON files against each other, log every
// fight, and print a machine-readable summary.
//
//   node tourney.mjs arena-lab/agent-a.json arena-lab/agent-b.json \
//        --matches 9 --log fights/gen01.log
//
// A wizard JSON file is the pure object: {name, epithet, color, color2,
// spells:[{name,desc,incantation}], policy}.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Duel } from "./src/engine.js";
import { parseArgs } from "./forge-common.mjs";

const [fileA, fileB] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const args = parseArgs(process.argv.slice(2).filter((a, i, all) =>
  a.startsWith("--") || (i > 0 && all[i - 1].startsWith("--"))));
const MATCHES = parseInt(args.matches || "9", 10);
const LOGFILE = args.log || null;

if (!fileA || !fileB) {
  console.error("usage: node tourney.mjs a.json b.json [--matches N] [--log file]");
  process.exit(1);
}
const defA = JSON.parse(readFileSync(fileA, "utf8"));
const defB = JSON.parse(readFileSync(fileB, "utf8"));

const strip = (s) => s.replace(/<[^>]*>/g, "");
const lines = [];
const say = (s) => lines.push(s);

const summary = {
  wizards: [defA.name, defB.name],
  wins: { [defA.name]: 0, [defB.name]: 0, draw: 0 },
  matches: [],
  compileErrors: [],
};

for (let m = 0; m < MATCHES; m++) {
  const matchLog = [];
  const duel = new Duel(defA, defB, (msg) => matchLog.push(strip(msg)));

  // instrument casts, damage, fizzles, winded episodes
  const stats = duel.wizards.map(() => ({ casts: {}, damage: 0, fizzles: 0, winded: 0, policyErrors: 0 }));
  const origCast = duel.tryCast.bind(duel);
  duel.tryCast = (w, i, tx, ty) => {
    const ok = origCast(w, i, tx, ty);
    if (ok && w.spells[i]) {
      const n = w.spells[i].name;
      stats[w.idx].casts[n] = (stats[w.idx].casts[n] || 0) + 1;
    }
    return ok;
  };
  const origDamage = duel.damage.bind(duel);
  duel.damage = (target, dmg, from, kind) => {
    if (from) stats[from.idx].damage += dmg;
    origDamage(target, dmg, from, kind);
  };

  if (m === 0) {
    for (const w of duel.wizards) {
      if (w.policy.error) summary.compileErrors.push(`${w.name} policy: ${w.policy.error}`);
      w.spells.forEach((s) => {
        if (s.compiled.error) summary.compileErrors.push(`${w.name} "${s.name}": ${s.compiled.error}`);
      });
    }
  }

  const dt = 1 / 60;
  let t = 0;
  let winded0 = false, winded1 = false;
  while (!duel.winner && t < 185) {
    duel.update(dt); t += dt;
    duel.wizards.forEach((w, i) => {
      const was = i === 0 ? winded0 : winded1;
      if (w.winded && !was) stats[i].winded++;
      if (i === 0) winded0 = w.winded; else winded1 = w.winded;
    });
    if (!duel.winner && duel.time > 180) {
      const [a, b] = duel.wizards;
      duel.kill(a.hp === b.hp ? (Math.random() < 0.5 ? a : b) : (a.hp < b.hp ? a : b));
      matchLog.push("⏳ Sudden death: the field claims the weaker wizard.");
    }
  }
  duel.wizards.forEach((w, i) => {
    stats[i].fizzles = matchLog.filter((l) => l.includes(`${w.name}'s`) && l.includes("fizzles")).length;
    stats[i].policyErrors = matchLog.filter((l) => l.includes(`${w.name}'s mind stutters`)).length;
  });

  const winner = duel.winner ? duel.winner.name : "draw";
  summary.wins[winner] = (summary.wins[winner] || 0) + 1;
  const rec = {
    match: m + 1,
    winner,
    duration: +duel.time.toFixed(1),
    finalHP: duel.wizards.map((w) => +w.hp.toFixed(0)),
    stats: duel.wizards.map((w, i) => ({
      name: w.name,
      damageDealt: +stats[i].damage.toFixed(0),
      casts: stats[i].casts,
      fizzles: stats[i].fizzles,
      policyErrors: stats[i].policyErrors,
      windedEpisodes: stats[i].winded,
    })),
  };
  summary.matches.push(rec);

  say(`\n═══════════ MATCH ${m + 1}: ${winner === "draw" ? "DRAW" : winner + " wins"} @ ${rec.duration}s ═══════════`);
  say(`final HP: ${defA.name}=${rec.finalHP[0]}  ${defB.name}=${rec.finalHP[1]}`);
  for (const s of rec.stats) {
    say(`${s.name}: dealt ${s.damageDealt} dmg | casts ${JSON.stringify(s.casts)} | fizzles ${s.fizzles} | policy errors ${s.policyErrors} | winded ×${s.windedEpisodes}`);
  }
  say("--- feed ---");
  for (const l of matchLog) say("  " + l);
}

say(`\n★ RESULT over ${MATCHES} matches: ${JSON.stringify(summary.wins)}`);
if (summary.compileErrors.length) say(`★ COMPILE ERRORS: ${summary.compileErrors.join(" | ")}`);

if (LOGFILE) {
  mkdirSync(dirname(LOGFILE), { recursive: true });
  writeFileSync(LOGFILE, lines.join("\n") + "\n");
}
console.log(JSON.stringify(summary, null, 2));
