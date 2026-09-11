import { RULES } from "./rules.js";
import { Duel } from "./engine.js";
import { buildBackground, render } from "./render.js";

const canvas = document.getElementById("game");
const g = canvas.getContext("2d");
g.imageSmoothingEnabled = false;

const feedEl = document.getElementById("feed");
const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlaySub = document.getElementById("overlay-sub");

let duel = null;

function feed(html) {
  const row = document.createElement("div");
  row.innerHTML = `<span class="t">${duel ? duel.time.toFixed(1) + "s" : "--"}</span>${html}`;
  feedEl.appendChild(row);
  feedEl.scrollTop = feedEl.scrollHeight;
  while (feedEl.children.length > 80) feedEl.removeChild(feedEl.firstChild);
}

const defs = (window.WIZARDS || []).slice(0, 2);
while (defs.length < 2) {
  defs.push({
    name: "Training Dummy",
    color: "#888888", color2: "#cccccc",
    spells: [{ name: "poke", desc: "a feeble jab", incantation: "ctx.bolt(ctx.aim,{damage:4,speed:100})" }],
    policy: "api.move(enemy.x-me.x, enemy.y-me.y); if(me.cooldowns[0]<=0) api.cast(0);",
  });
}

duel = new Duel(defs[0], defs[1], feed);
let phase = "countdown";
let phaseT = 0;
const bg = buildBackground();

function panel(w, el) {
  const spells = w.spells.map((s, i) => `
    <div class="spell-row">
      <span class="sname" style="color:${w.color2}">${i + 1}. ${s.name}</span>
      ${s.element !== "neutral" ? `<span class="slen">[${s.element}]</span>` : ""}
      <span class="scost">${s.cost}♦</span>
      <span class="slen">(${s.incant.length} runes)</span>
      ${s.compiled.error ? `<span style="color:#ff6b6b">✗ ${s.compiled.error}</span>` : ""}
      <span class="sdesc">${s.desc}</span>
    </div>`).join("");
  el.innerHTML = `
    <div class="title-line"><h3 style="color:${w.color}">${w.name}</h3>
      ${w.element !== "neutral" ? `<span class="slen">☄ ${w.element}</span>` : ""}</div>
    <div class="epithet">${w.def.epithet || ""}</div>
    ${spells}
    <div class="polinfo">policy: ${w.policySrc.length} runes → ${w.policyCost.toFixed(2)} stamina / tick
    ${w.policy.error ? `<br><span style="color:#ff6b6b">✗ ${w.policy.error}</span>` : ""}</div>`;
}
panel(duel.wizards[0], document.getElementById("panel-0"));
panel(duel.wizards[1], document.getElementById("panel-1"));

feed(`⚔ <b style="color:${duel.wizards[0].color}">${duel.wizards[0].name}</b> challenges <b style="color:${duel.wizards[1].color}">${duel.wizards[1].name}</b> upon the open field.`);

document.getElementById("btn-restart").addEventListener("click", () => {
  duel.reset();
  overlay.classList.add("hidden");
  phase = "countdown"; phaseT = 0;
  feed("⚔ The circle is drawn anew.");
});

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (phase === "countdown") {
    phaseT += dt;
    duel.update(0); // keep fx timers frozen but allow render
    if (phaseT >= 3.6) phase = "battle";
  } else if (phase === "battle") {
    duel.update(dt);
    if (duel.winner && duel.overTimer > 1.4) {
      phase = "over";
      overlayTitle.textContent = `${duel.winner.name.toUpperCase()} WINS`;
      overlayTitle.style.color = duel.winner.color;
      overlaySub.textContent = `victory in ${duel.time.toFixed(1)}s — the field remembers.`;
      overlay.classList.remove("hidden");
    }
    // sudden-death safeguard: after 3 minutes the healthier wizard wins
    if (!duel.winner && duel.time > 180) {
      const [a, b] = duel.wizards;
      const loser = a.hp === b.hp ? b : (a.hp < b.hp ? a : b);
      duel.damage(loser, 9999, null, "exhaustion");
    }
  }

  render(g, duel, bg, phase, phaseT);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
