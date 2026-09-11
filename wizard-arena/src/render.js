import { RULES } from "./rules.js";

// deterministic rng for the background
function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildBackground() {
  const c = document.createElement("canvas");
  c.width = RULES.W; c.height = RULES.H;
  const g = c.getContext("2d");
  const A = RULES.ARENA;
  const rnd = mulberry(1337);

  // night sky band behind the field
  g.fillStyle = "#141021"; g.fillRect(0, 0, RULES.W, RULES.H);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = rnd() < 0.3 ? "#4a4370" : "#2c2647";
    g.fillRect((rnd() * RULES.W) | 0, (rnd() * (A.y - 8)) | 0, 1, 1);
  }

  // the open field
  const grass = ["#2c5a35", "#316341", "#28513a", "#356b3c"];
  for (let y = A.y; y < A.y + A.h; y += 4) {
    for (let x = A.x; x < A.x + A.w; x += 4) {
      const stripe = ((y / 16) | 0) % 2 ? 0.06 : 0;
      const t = rnd() + stripe;
      g.fillStyle = grass[(t * grass.length) | 0] || grass[0];
      g.fillRect(x, y, 4, 4);
    }
  }
  // blades / flowers / stones
  for (let i = 0; i < 260; i++) {
    const x = A.x + rnd() * A.w, y = A.y + rnd() * A.h, r = rnd();
    if (r < 0.75) { g.fillStyle = "#3f7a48"; g.fillRect(x, y, 1, 2); }
    else if (r < 0.87) { g.fillStyle = rnd() < 0.5 ? "#e8dcc0" : "#d98cb0"; g.fillRect(x, y, 1, 1); }
    else { g.fillStyle = "#57606a"; g.fillRect(x, y, 2, 2); g.fillStyle = "#79828c"; g.fillRect(x, y, 2, 1); }
  }

  // central summoning ring
  const cx = A.x + A.w / 2, cy = A.y + A.h / 2;
  g.strokeStyle = "rgba(232,182,76,.28)"; g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, 34, 0, 7); g.stroke();
  g.beginPath(); g.arc(cx, cy, 26, 0, 7); g.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.fillStyle = "rgba(232,182,76,.5)";
    g.fillRect(cx + Math.cos(a) * 30 - 1, cy + Math.sin(a) * 30 - 1, 2, 2);
  }

  // stone border
  g.fillStyle = "#3a3355";
  g.fillRect(A.x - 4, A.y - 4, A.w + 8, 4); g.fillRect(A.x - 4, A.y + A.h, A.w + 8, 4);
  g.fillRect(A.x - 4, A.y, 4, A.h); g.fillRect(A.x + A.w, A.y, 4, A.h);
  g.fillStyle = "#514a78";
  for (let x = A.x - 4; x < A.x + A.w + 8; x += 8) { g.fillRect(x, A.y - 4, 4, 2); g.fillRect(x + 2, A.y + A.h + 1, 4, 2); }

  // vignette
  const v = g.createRadialGradient(cx, cy, 80, cx, cy, 300);
  v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.45)");
  g.fillStyle = v; g.fillRect(0, 0, RULES.W, RULES.H);
  return c;
}

function px(g, x, y, w, h, color) { g.fillStyle = color; g.fillRect(x | 0, y | 0, w, h); }

function drawWizard(g, w, t) {
  const bobY = Math.sin(w.bob) * 1.2;
  const x = w.x | 0, y = (w.y + bobY) | 0, f = w.facing;
  const flash = w.hitFlash > 0;
  const body = flash ? "#ffffff" : w.color;
  const trim = flash ? "#ffffff" : w.color2;
  const dark = flash ? "#dddddd" : shade(w.color, -45);

  g.save();
  // shadow
  g.fillStyle = "rgba(0,0,0,.35)";
  g.beginPath(); g.ellipse(x, w.y + 7, 6, 2, 0, 0, 7); g.fill();

  // cape flutter
  px(g, x - f * 6, y - 4 + Math.sin(t * 8 + w.idx) * 1, 3, 8, dark);
  // robe
  px(g, x - 4, y - 6, 8, 12, body);
  px(g, x - 5, y + 2, 10, 4, body);
  px(g, x - 5, y + 5, 10, 1, dark);
  // trim sash
  px(g, x - 4, y + 1, 8, 1, trim);
  // face in hood
  px(g, x - 2 + f, y - 5, 4, 3, "#1a1420");
  px(g, x - 1 + f * 2, y - 5, 1, 1, trim); // glowing eye
  px(g, x + 1 + f * 2, y - 5, 1, 1, trim);
  // pointed hat
  px(g, x - 6, y - 8, 12, 2, body);
  px(g, x - 4, y - 10, 8, 2, body);
  px(g, x - 3, y - 13, 5, 3, body);
  px(g, x - 1 + f, y - 16, 3, 3, body);
  px(g, x - 6, y - 8, 12, 1, trim);
  // hands / focus orb when casting
  if (w.castFlash > 0) {
    const o = 8 * f;
    g.fillStyle = trim;
    g.beginPath(); g.arc(x + o, y - 2, 2.5 + Math.sin(t * 40) * 0.8, 0, 7); g.fill();
  }
  // shield bubble
  if (w.shield > 0.5) {
    g.strokeStyle = `rgba(200,192,255,${0.35 + 0.2 * Math.sin(t * 6)})`;
    g.lineWidth = 1;
    g.beginPath(); g.arc(x, y - 3, 11 + Math.sin(t * 5) * 0.7, 0, 7); g.stroke();
  }
  if (w.exhausted || w.winded) {
    g.fillStyle = "#e8b64c";
    g.font = "6px monospace";
    g.fillText("zZ", x + 6, y - 16);
  }
  g.restore();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const gg = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${gg},${b})`;
}

function bar(g, x, y, w, h, frac, color, back = "#14111f") {
  px(g, x - 1, y - 1, w + 2, h + 2, "#000");
  px(g, x, y, w, h, back);
  px(g, x, y, Math.round(w * Math.max(0, Math.min(1, frac))), h, color);
}

function hud(g, duel) {
  g.font = "7px 'Press Start 2P', monospace";
  g.textBaseline = "top";
  duel.wizards.forEach((w, i) => {
    const left = i === 0;
    const bx = left ? 10 : RULES.W - 150;
    g.textAlign = left ? "left" : "right";
    g.fillStyle = w.color;
    g.fillText(w.name.toUpperCase().slice(0, 16), left ? bx : RULES.W - 10, 8);
    g.textAlign = "left";
    bar(g, bx, 20, 140, 5, w.hp / RULES.MAX_HP, "#7ee06a");
    if (w.shield > 0) bar(g, bx, 20, Math.round(140 * (w.shield / RULES.MAX_HP)), 5, 1, "rgba(200,192,255,.9)", "transparent");
    bar(g, bx, 28, 140, 3, w.mana / RULES.MAX_MANA, "#5cc8ff");
    bar(g, bx, 33, 140, 2, w.stamina / RULES.MAX_STAMINA, "#e8b64c");
  });
  g.textAlign = "center";
  g.fillStyle = "#5e577a";
  g.fillText(duel.time.toFixed(0).padStart(3, "0"), RULES.W / 2, 12);
}

export function render(g, duel, bg, phase, phaseT) {
  const shx = (Math.random() - 0.5) * duel.shake;
  const shy = (Math.random() - 0.5) * duel.shake;
  g.save();
  g.translate(shx | 0, shy | 0);
  g.drawImage(bg, 0, 0);

  // sort by y for painter's order
  const wiz = [...duel.wizards].sort((a, b) => a.y - b.y);
  for (const w of wiz) if (!w.dead) drawWizard(g, w, duel.time);

  // trap runes
  for (const rn of duel.runes) {
    const armed = rn.arm <= 0;
    const pulse = 0.5 + 0.5 * Math.sin(duel.time * (armed ? 9 : 3));
    g.globalAlpha = armed ? 0.5 + 0.3 * pulse : 0.25;
    g.strokeStyle = rn.color;
    g.beginPath(); g.arc(rn.x, rn.y, rn.r * (armed ? 1 : 0.85), 0, 7); g.stroke();
    g.fillStyle = armed ? rn.color2 : rn.color;
    g.fillRect(rn.x - 1, rn.y - 1, 2, 2);
    g.globalAlpha = 1;
  }

  // novas
  for (const n of duel.novaFx) {
    const a = n.life / n.maxLife;
    g.strokeStyle = n.color; g.globalAlpha = a; g.lineWidth = 2 + a * 2;
    g.beginPath(); g.arc(n.x, n.y, n.r, 0, 7); g.stroke();
    g.globalAlpha = 1;
  }

  // projectiles
  for (const p of duel.projectiles) {
    g.fillStyle = p.color2;
    g.beginPath(); g.arc(p.x, p.y, p.r + 0.8, 0, 7); g.fill();
    g.fillStyle = p.color;
    g.beginPath(); g.arc(p.x, p.y, p.r * 0.6, 0, 7); g.fill();
  }

  // particles
  for (const p of duel.particles) {
    g.globalAlpha = Math.max(0, p.life / p.maxLife);
    g.fillStyle = p.color;
    const s = Math.max(1, p.size * (p.life / p.maxLife));
    g.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  }
  g.globalAlpha = 1;

  // damage numbers
  g.font = "7px 'Press Start 2P', monospace";
  g.textAlign = "center";
  for (const n of duel.numbers) {
    g.globalAlpha = Math.min(1, n.life * 2);
    g.fillStyle = "#000"; g.fillText(n.text, n.x + 1, n.y + 1);
    g.fillStyle = n.color; g.fillText(n.text, n.x, n.y);
  }
  g.globalAlpha = 1;

  hud(g, duel);

  // countdown
  if (phase === "countdown") {
    const n = Math.ceil(3 - phaseT);
    g.font = "22px 'Press Start 2P', monospace";
    g.textAlign = "center";
    const s = 1 + (1 - ((3 - phaseT) % 1)) * 0.15;
    g.save();
    g.translate(RULES.W / 2, RULES.H / 2); g.scale(s, s);
    g.fillStyle = "#000"; g.fillText(n > 0 ? String(n) : "FIGHT", 2, 2);
    g.fillStyle = "#e8b64c"; g.fillText(n > 0 ? String(n) : "FIGHT", 0, 0);
    g.restore();
  }
  g.restore();
}
