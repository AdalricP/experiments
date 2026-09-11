import { RULES, spellManaCost, policyStaminaCost, elementMult } from "./rules.js";
import { compile } from "./sandbox.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class Wizard {
  constructor(def, idx) {
    this.def = def;
    this.idx = idx;
    this.name = def.name || `Wizard ${idx + 1}`;
    this.color = def.color || (idx === 0 ? "#ff6b3d" : "#5cc8ff");
    this.color2 = def.color2 || (idx === 0 ? "#ffd23d" : "#c8f0ff");

    this.element = RULES.ELEMENTS.includes(def.element) ? def.element : "neutral";
    this.spells = (def.spells || []).slice(0, RULES.MAX_SPELLS).map((s) => {
      const incant = String(s.incantation || "").slice(0, RULES.MAX_INCANT_CHARS);
      const elem = RULES.ELEMENTS.includes(s.element) ? s.element : "neutral";
      return {
        name: s.name || "spell",
        desc: s.desc || "",
        incant,
        element: elem,
        cost: spellManaCost(incant, elem !== "neutral" && elem === this.element),
        compiled: compile(incant, ["ctx", "me", "enemy"]),
        cd: 0,
      };
    });

    const polSrc = String(def.policy || "").slice(0, RULES.MAX_POLICY_CHARS);
    this.policySrc = polSrc;
    this.policyCost = policyStaminaCost(polSrc);
    this.policy = compile(polSrc, ["api", "me", "enemy", "arena", "memory"]);
    this.memory = {};
    this.reset();
  }

  reset() {
    this.hp = RULES.MAX_HP;
    this.mana = RULES.START_MANA;
    this.stamina = RULES.MAX_STAMINA;
    this.shield = 0;
    this.recentHeal = 0;   // drives diminishing heal returns; decays over time
    this.dots = [];        // active curses: {dps, t, from, element, acc}
    this.slowPct = 0; this.slowT = 0;
    this.reflectT = 0;
    this.leechPct = 0; this.leechT = 0;
    this.x = 0; this.y = 0;
    this.mx = 0; this.my = 0;
    this.facing = 1;
    this.haste = 1; this.hasteT = 0;
    this.gcd = 0;
    this.policyClock = Math.random() * RULES.POLICY_TICK;
    this.exhausted = false;
    this.winded = false;
    this.bob = Math.random() * 6;
    this.hitFlash = 0;
    this.castFlash = 0;
    this.memory = {};
    this.spells.forEach((s) => (s.cd = 0));
    this.dead = false;
  }

  snapshot() {
    return {
      x: this.x, y: this.y, hp: this.hp, mana: this.mana,
      stamina: this.stamina, shield: this.shield, winded: this.winded,
      element: this.element, slowed: this.slowT > 0, reflecting: this.reflectT > 0,
      cooldowns: this.spells.map((s) => Math.max(0, s.cd)),
      spellCosts: this.spells.map((s) => s.cost),
    };
  }
}

export class Duel {
  constructor(defA, defB, log = () => {}) {
    this.log = log;
    this.wizards = [new Wizard(defA, 0), new Wizard(defB, 1)];
    this.reset();
    for (const w of this.wizards) {
      if (w.policy.error) this.log(`⚠ ${w.name}'s policy failed to compile (${w.policy.error})`);
      w.spells.forEach((s) => {
        if (s.compiled.error) this.log(`⚠ ${w.name}'s "${s.name}" is miscast scripture (${s.compiled.error})`);
      });
    }
  }

  reset() {
    const A = RULES.ARENA;
    this.time = 0;
    this.projectiles = [];
    this.runes = [];
    this.novaFx = [];
    this.particles = [];
    this.numbers = [];
    this.shake = 0;
    this.winner = null;
    this.overTimer = 0;
    this.wizards.forEach((w, i) => {
      w.reset();
      w.x = A.x + (i === 0 ? 60 : A.w - 60);
      w.y = A.y + A.h / 2;
      w.facing = i === 0 ? 1 : -1;
    });
  }

  // ---------------- casting ----------------

  tryCast(w, idx, tx, ty) {
    const s = w.spells[idx];
    if (!s || s.compiled.error || w.dead) return false;
    if (w.gcd > 0 || s.cd > 0 || w.mana < s.cost) return false;

    w.mana -= s.cost;
    s.cd = RULES.SPELL_COOLDOWN;
    w.gcd = RULES.GLOBAL_COOLDOWN;
    w.castFlash = 0.25;

    const enemy = this.wizards[1 - w.idx];
    let budget = s.cost * RULES.POWER_PER_MANA;
    let calls = 0;
    const P = RULES.PRICE;
    const elem = s.element;
    const spend = (amt) => {
      if (++calls > RULES.CALLS_PER_CAST) return false;
      if (budget < amt) return false;
      budget -= amt; return true;
    };
    const aimAngle = (tx !== undefined && ty !== undefined)
      ? Math.atan2(ty - w.y, tx - w.x)
      : Math.atan2(enemy.y - w.y, enemy.x - w.x);

    const ctx = {
      aim: aimAngle,
      dist: dist(w, enemy),
      time: this.time,
      rand: Math.random,
      budget: () => budget,
      bolt: (angle, opts = {}) => {
        const dmg = clamp(+opts.damage || 6, 1, RULES.BOLT_DMG_MAX);
        const homing = !!opts.homing;
        const spd = clamp(+opts.speed || 130, 40, 260);
        // speed costs: 130 → ×1.0, 260 → ×1.3, 40 → ×0.79
        const price = dmg * P.BOLT_PER_DMG * (0.7 + 0.6 * spd / 260) * (homing ? 1.6 : 1);
        if (!spend(price)) return false;
        this.projectiles.push({
          owner: w.idx,
          x: w.x, y: w.y - 4,
          vx: Math.cos(angle), vy: Math.sin(angle),
          speed: spd,
          dmg,
          r: clamp(+opts.radius || 2.5, 1.5, 5),
          homing,
          element: elem,
          color: w.color, color2: w.color2,
          life: 3.2,
        });
        return true;
      },
      nova: (damage, radius) => {
        const dmg = clamp(+damage || 8, 1, RULES.BOLT_DMG_MAX);
        const r = clamp(+radius || 40, 15, RULES.NOVA_R_MAX);
        if (!spend(dmg * P.NOVA_PER_DMG_R40 * (Math.max(r, 40) / 40))) return false;
        this.novaFx.push({ x: w.x, y: w.y, r: 4, maxR: r, color: w.color, life: 0.35, maxLife: 0.35 });
        if (dist(w, enemy) <= r + RULES.RADIUS) this.damage(enemy, dmg, w, { element: elem });
        this.shake = Math.max(this.shake, 3 + dmg * 0.15);
        return true;
      },
      heal: (hp) => {
        // Diminishing returns: granted = request / (1 + recentHeal/FALLOFF)
        const want = clamp(+hp || 5, 0, 50);
        const eff = 1 / (1 + w.recentHeal / RULES.HEAL_FALLOFF);
        const granted = Math.min(want * eff, RULES.MAX_HP - w.hp);
        if (granted <= 0.2) return false;
        if (!spend(granted * P.HEAL_PER_HP)) return false;
        w.hp += granted; w.recentHeal += granted;
        this.number(w.x, w.y - 14, `+${Math.round(granted)}`, "#7ee06a");
        this.burst(w.x, w.y, "#7ee06a", 10, 30);
        return true;
      },
      strike: (damage) => {
        // PHYSICAL: melee range, costs stamina, half-pierces shields, no element
        const dmg = clamp(+damage || 6, 1, RULES.STRIKE_DMG_MAX);
        if (dist(w, enemy) > RULES.STRIKE_RANGE) return false;
        const stam = dmg * P.STRIKE_STAMINA_PER_DMG;
        if (++calls > RULES.CALLS_PER_CAST || w.stamina < stam) return false;
        w.stamina -= stam;
        this.damage(enemy, dmg, w, { pierce: RULES.STRIKE_SHIELD_PIERCE });
        this.shake = Math.max(this.shake, 2.5);
        return true;
      },
      lunge: (angle, distPx) => {
        // PHYSICAL: quick stamina-fueled dash
        const px = clamp(+distPx || 30, 5, RULES.LUNGE_MAX_PX);
        const stam = px * P.LUNGE_STAMINA_PER_PX;
        if (++calls > RULES.CALLS_PER_CAST || w.stamina < stam) return false;
        w.stamina -= stam;
        const A = RULES.ARENA;
        this.burst(w.x, w.y + 4, "#6d5f4b", 8, 25);
        w.x = clamp(w.x + Math.cos(angle) * px, A.x + 6, A.x + A.w - 6);
        w.y = clamp(w.y + Math.sin(angle) * px, A.y + 6, A.y + A.h - 6);
        return true;
      },
      curse: (dps, seconds) => {
        const d = clamp(+dps || 2, 0.5, RULES.CURSE_DPS_MAX);
        const sec = clamp(+seconds || 3, 1, RULES.CURSE_SEC_MAX);
        if (!spend(d * sec * P.CURSE_PER_DMG)) return false;
        enemy.dots.push({ dps: d, t: sec, from: w.idx, element: elem, acc: 0 });
        this.number(enemy.x, enemy.y - 18, "☠", "#b06ee0");
        return true;
      },
      slow: (pct, seconds) => {
        const p = clamp(+pct || 20, 5, RULES.SLOW_PCT_MAX);
        const sec = clamp(+seconds || 2, 0.5, RULES.SLOW_SEC_MAX);
        if (!spend(p * sec * P.SLOW_PER_PCT_SEC)) return false;
        enemy.slowPct = Math.max(enemy.slowPct, p); enemy.slowT = Math.max(enemy.slowT, sec);
        this.burst(enemy.x, enemy.y + 4, "#5cc8ff", 8, 20);
        return true;
      },
      sacrifice: (hp) => {
        // blood magic: burn your own HP for extra power budget, mid-cast
        const burn = clamp(+hp || 5, 1, RULES.SACRIFICE_MAX_HP);
        if (++calls > RULES.CALLS_PER_CAST) return false;
        if (w.hp - burn < RULES.SACRIFICE_FLOOR) return false;
        w.hp -= burn;
        budget += burn * P.SACRIFICE_POWER_PER_HP;
        this.number(w.x, w.y - 14, `-${Math.round(burn)}`, "#e05a5a");
        this.burst(w.x, w.y - 4, "#c22", 12, 35);
        return true;
      },
      swap: () => {
        if (!spend(P.SWAP_FLAT)) return false;
        this.burst(w.x, w.y, w.color, 14, 45);
        this.burst(enemy.x, enemy.y, w.color2, 14, 45);
        const wx = w.x, wy = w.y;
        w.x = enemy.x; w.y = enemy.y;
        enemy.x = wx; enemy.y = wy;
        this.log(`⇄ ${w.name} trades places with ${enemy.name}!`);
        return true;
      },
      push: (px) => {
        // + pushes the enemy away, − drags them toward you
        const amt = clamp(+px || 30, -RULES.PUSH_MAX_PX, RULES.PUSH_MAX_PX);
        if (!spend(Math.abs(amt) * P.PUSH_PER_PX)) return false;
        const d = dist(w, enemy) || 1;
        const ux = (enemy.x - w.x) / d, uy = (enemy.y - w.y) / d;
        const A = RULES.ARENA;
        enemy.x = clamp(enemy.x + ux * amt, A.x + 6, A.x + A.w - 6);
        enemy.y = clamp(enemy.y + uy * amt, A.y + 6, A.y + A.h - 6);
        this.burst(enemy.x, enemy.y, w.color, 8, 30);
        return true;
      },
      reflect: (seconds) => {
        const sec = clamp(+seconds || 1, 0.3, RULES.REFLECT_MAX_SEC);
        if (!spend(sec * P.REFLECT_PER_SEC)) return false;
        w.reflectT = Math.max(w.reflectT, sec);
        this.burst(w.x, w.y - 4, "#fff", 10, 26);
        return true;
      },
      rune: (x, y, damage, radius, armSeconds) => {
        if (this.runes.filter((r) => r.owner === w.idx).length >= RULES.RUNES_MAX) return false;
        const dmg = clamp(+damage || 10, 1, RULES.RUNE_DMG_MAX);
        const r = clamp(+radius || 30, 15, 50);
        const arm = clamp(+armSeconds || 0.8, 0.4, 3);
        if (!spend(dmg * P.RUNE_PER_DMG_R40 * (Math.max(r, 40) / 40))) return false;
        const A = RULES.ARENA;
        this.runes.push({
          owner: w.idx, element: elem,
          x: clamp(+x || w.x, A.x + 6, A.x + A.w - 6),
          y: clamp(+y || w.y, A.y + 6, A.y + A.h - 6),
          r, dmg, arm, life: RULES.RUNE_LIFE,
          color: w.color, color2: w.color2,
        });
        return true;
      },
      leech: (pct, seconds) => {
        const p = clamp(+pct || 15, 5, RULES.LEECH_PCT_MAX);
        const sec = clamp(+seconds || 2, 1, RULES.LEECH_SEC_MAX);
        if (!spend(p * sec * P.LEECH_PER_PCT_SEC)) return false;
        w.leechPct = p; w.leechT = sec;
        this.burst(w.x, w.y - 4, "#b06ee0", 8, 22);
        return true;
      },
      shield: (hp) => {
        const amt = clamp(+hp || 8, 1, RULES.SHIELD_MAX - w.shield);
        if (amt <= 0 || !spend(amt * P.SHIELD_PER_HP)) return false;
        w.shield = clamp(w.shield + amt, 0, RULES.SHIELD_MAX);
        this.burst(w.x, w.y, "#c8c0ff", 8, 24);
        return true;
      },
      blink: (dx, dy) => {
        const d = Math.hypot(dx, dy) || 1;
        const px = Math.min(d, RULES.BLINK_MAX_PX);
        if (!spend(px * P.BLINK_PER_PX)) return false;
        this.burst(w.x, w.y, w.color, 12, 40);
        const A = RULES.ARENA;
        w.x = clamp(w.x + (dx / d) * px, A.x + 6, A.x + A.w - 6);
        w.y = clamp(w.y + (dy / d) * px, A.y + 6, A.y + A.h - 6);
        this.burst(w.x, w.y, w.color2, 12, 40);
        return true;
      },
      haste: (pct, seconds) => {
        const p = clamp(+pct || 25, 5, 80);
        const sec = clamp(+seconds || 2, 0.5, 5);
        if (!spend(p * sec * P.HASTE_PER_PCT_SEC)) return false;
        w.haste = 1 + p / 100; w.hasteT = sec;
        return true;
      },
    };

    try {
      s.compiled.run(ctx, w.snapshot(), enemy.snapshot());
    } catch (e) {
      this.log(`✦ ${w.name}'s "${s.name}" fizzles (${e.message})`);
      return true;
    }
    this.burst(w.x, w.y - 6, w.color2, 6, 20);
    this.log(`✦ ${w.name} casts <b style="color:${w.color}">${s.name}</b> (${s.cost}♦)`);
    return true;
  }

  damage(target, dmg, from, opts = {}) {
    if (target.dead) return;
    const mult = elementMult(opts.element, target.element);
    let d = dmg * mult;
    if (target.shield > 0) {
      // physical pierce lets a fraction of the hit skip the shield entirely
      const pierced = d * (opts.pierce || 0);
      const absorbable = d - pierced;
      const absorbed = Math.min(target.shield, absorbable);
      target.shield -= absorbed; d = pierced + (absorbable - absorbed);
      if (absorbed > 0) this.number(target.x, target.y - 18, `◈${Math.round(absorbed)}`, "#c8c0ff");
    }
    if (d > 0) {
      target.hp -= d;
      target.hitFlash = 0.18;
      // lifesteal: attacker's leech converts a cut of dealt damage to healing,
      // routed through the same diminishing-returns curve as ctx.heal
      if (from && !from.dead && from.leechT > 0) {
        const eff = 1 / (1 + from.recentHeal / RULES.HEAL_FALLOFF);
        const granted = Math.min(d * (from.leechPct / 100) * eff, RULES.MAX_HP - from.hp);
        if (granted > 0.2) {
          from.hp += granted; from.recentHeal += granted;
          this.number(from.x, from.y - 14, `+${Math.round(granted)}`, "#b06ee0");
        }
      }
      const tag = mult > 1 ? "!" : mult < 1 ? "˘" : "";
      const col = mult > 1 ? "#ffd23d" : mult < 1 ? "#9aa0b8" : "#ffffff";
      this.number(target.x, target.y - 12, `${Math.round(d)}${tag}`, col);
      this.burst(target.x, target.y - 4, from ? from.color : "#fff", 8 + d, 50);
      this.shake = Math.max(this.shake, 1.5 + d * 0.2);
    }
    if (target.hp <= 0) this.kill(target);
  }

  kill(target) {
    if (target.dead) return;
    target.hp = 0; target.dead = true;
    this.winner = this.wizards[1 - target.idx];
    this.burst(target.x, target.y, target.color, 60, 90);
    this.shake = 8;
    this.log(`☠ <b>${target.name}</b> falls. <b style="color:${this.winner.color}">${this.winner.name}</b> is victorious!`);
  }

  // ---------------- policy ----------------

  runPolicy(w, dt) {
    w.policyClock -= dt;
    if (w.policyClock > 0) return;
    w.policyClock += RULES.POLICY_TICK;

    if (w.policy.error) return;
    if (w.stamina < w.policyCost) { w.exhausted = true; return; }
    w.exhausted = false;
    w.stamina -= w.policyCost;

    const enemy = this.wizards[1 - w.idx];
    const casts = [];
    let moved = false;
    const threats = this.projectiles
      .filter((p) => p.owner !== w.idx)
      .map((p) => ({
        x: p.x, y: p.y, dx: p.vx, dy: p.vy, speed: p.speed,
        damage: p.dmg, homing: p.homing,
        dist: Math.hypot(p.x - w.x, p.y - w.y),
      }))
      .sort((a, b) => a.dist - b.dist);
    const hazards = this.runes
      .filter((rn) => rn.owner !== w.idx)
      .map((rn) => ({ x: rn.x, y: rn.y, r: rn.r, armed: rn.arm <= 0, dist: Math.hypot(rn.x - w.x, rn.y - w.y) }))
      .sort((a, b) => a.dist - b.dist);
    const api = {
      threats,
      hazards,
      move: (dx, dy) => {
        const d = Math.hypot(dx, dy);
        if (d > 0.001) { w.mx = dx / d; w.my = dy / d; moved = true; }
      },
      stop: () => { w.mx = 0; w.my = 0; moved = true; },
      cast: (i, tx, ty) => { if (casts.length < 2) casts.push([i | 0, tx, ty]); },
      rand: Math.random,
      time: this.time,
    };
    try {
      w.policy.run(api, w.snapshot(), enemy.snapshot(), { ...RULES.ARENA }, w.memory);
    } catch (e) {
      this.log(`⚠ ${w.name}'s mind stutters (${e.message})`);
    }
    for (const [i, tx, ty] of casts) this.tryCast(w, i, tx, ty);
  }

  // ---------------- update ----------------

  update(dt) {
    this.time += dt;
    const A = RULES.ARENA;

    for (const w of this.wizards) {
      if (w.dead) continue;

      // winded transitions — spent wizards crawl and bleed until stamina refills
      const WD = RULES.WINDED;
      if (!w.winded && w.stamina <= WD.THRESHOLD) {
        w.winded = true;
        this.log(`✥ <b style="color:${w.color}">${w.name}</b> is winded — slowed and bleeding until stamina refills!`);
      } else if (w.winded && w.stamina >= RULES.MAX_STAMINA - 0.5) {
        w.winded = false;
        this.log(`✥ ${w.name} catches their breath.`);
      }

      // regen (or exhaustion bleed)
      if (w.winded) {
        w.hp -= WD.HP_DRAIN * dt;
        w.mana = clamp(w.mana - WD.MANA_DRAIN * dt, 0, RULES.MAX_MANA);
        if (w.hp <= 0 && !this.winner) { this.kill(w); continue; }
      } else {
        w.hp = clamp(w.hp + RULES.HP_REGEN * dt, 0, RULES.MAX_HP);
        w.mana = clamp(w.mana + RULES.MANA_REGEN * dt, 0, RULES.MAX_MANA);
      }
      w.stamina = clamp(w.stamina + RULES.STAMINA_REGEN * dt, 0, RULES.MAX_STAMINA);
      w.recentHeal = Math.max(0, w.recentHeal - RULES.HEAL_DECAY * dt);
      w.shield = Math.max(0, w.shield - RULES.SHIELD_DECAY * dt);

      // curses tick in half-second pulses
      for (const dot of w.dots) {
        dot.t -= dt; dot.acc += dot.dps * dt;
        if (dot.acc >= dot.dps * 0.5 || dot.t <= 0) {
          if (dot.acc > 0.1) this.damage(w, dot.acc, this.wizards[dot.from], { element: dot.element });
          dot.acc = 0;
        }
      }
      w.dots = w.dots.filter((dot) => dot.t > 0 && !w.dead);
      if (w.dead) continue;
      w.slowT = Math.max(0, w.slowT - dt);
      if (w.slowT === 0) w.slowPct = 0;
      w.reflectT = Math.max(0, w.reflectT - dt);
      w.leechT = Math.max(0, w.leechT - dt);
      if (w.leechT === 0) w.leechPct = 0;

      // timers
      w.gcd = Math.max(0, w.gcd - dt);
      w.hitFlash = Math.max(0, w.hitFlash - dt);
      w.castFlash = Math.max(0, w.castFlash - dt);
      if ((w.hasteT -= dt) <= 0) w.haste = 1;
      w.spells.forEach((s) => (s.cd = Math.max(0, s.cd - dt)));

      if (!this.winner && !w.winded) this.runPolicy(w, dt);

      // movement
      const spd = RULES.MOVE_SPEED * w.haste *
        (w.winded ? RULES.WINDED.SPEED_MULT : 1) *
        (w.slowT > 0 ? 1 - w.slowPct / 100 : 1);
      w.x = clamp(w.x + w.mx * spd * dt, A.x + 6, A.x + A.w - 6);
      w.y = clamp(w.y + w.my * spd * dt, A.y + 6, A.y + A.h - 6);
      if (Math.abs(w.mx) > 0.01) w.facing = Math.sign(w.mx);
      else w.facing = Math.sign(this.wizards[1 - w.idx].x - w.x) || w.facing;
      w.bob += dt * (w.mx || w.my ? 10 : 4);

      // run dust
      if ((w.mx || w.my) && Math.random() < dt * 14) {
        this.particles.push({
          x: w.x - w.mx * 4, y: w.y + 5, vx: -w.mx * 12, vy: -6 - Math.random() * 8,
          life: 0.4, maxLife: 0.4, color: "#6d5f4b", size: 1.5, grav: 30,
        });
      }
    }

    // projectiles
    for (const p of this.projectiles) {
      const target = this.wizards[1 - p.owner];
      if (p.homing && !target.dead) {
        const want = Math.atan2(target.y - p.y, target.x - p.x);
        const cur = Math.atan2(p.vy, p.vx);
        let d = want - cur;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const turn = clamp(d, -1.2 * dt, 1.2 * dt);
        p.vx = Math.cos(cur + turn); p.vy = Math.sin(cur + turn);
      }
      p.x += p.vx * p.speed * dt;
      p.y += p.vy * p.speed * dt;
      p.life -= dt;
      // trail
      if (Math.random() < 0.85) this.particles.push({
        x: p.x, y: p.y, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14,
        life: 0.28, maxLife: 0.28, color: Math.random() < 0.5 ? p.color : p.color2,
        size: p.r * 0.7, grav: 0,
      });
      if (!target.dead && Math.hypot(p.x - target.x, p.y - (target.y - 3)) < p.r + RULES.RADIUS) {
        if (target.reflectT > 0) {
          // mirrored back at its caster — now the reflector's projectile
          p.owner = target.idx;
          p.vx = -p.vx; p.vy = -p.vy;
          p.x += p.vx * 8; p.y += p.vy * 8;
          p.life = 3.2;
          this.burst(target.x, target.y - 4, "#ffffff", 10, 35);
          this.number(target.x, target.y - 18, "↩", "#ffffff");
        } else {
          this.damage(target, p.dmg, this.wizards[p.owner], { element: p.element });
          p.life = 0;
        }
      }
      if (p.x < A.x - 8 || p.x > A.x + A.w + 8 || p.y < A.y - 8 || p.y > A.y + A.h + 8) p.life = 0;
    }
    this.projectiles = this.projectiles.filter((p) => p.life > 0);

    // trap runes: arm, then detonate on enemy contact
    for (const rn of this.runes) {
      rn.arm -= dt; rn.life -= dt;
      if (rn.arm <= 0 && rn.life > 0) {
        const foe = this.wizards[1 - rn.owner];
        if (!foe.dead && Math.hypot(rn.x - foe.x, rn.y - foe.y) <= rn.r) {
          this.novaFx.push({ x: rn.x, y: rn.y, r: 4, maxR: rn.r, color: rn.color, life: 0.35, maxLife: 0.35 });
          this.damage(foe, rn.dmg, this.wizards[rn.owner], { element: rn.element });
          this.shake = Math.max(this.shake, 3);
          rn.life = 0;
        }
      }
    }
    this.runes = this.runes.filter((rn) => rn.life > 0);

    // fx
    for (const n of this.novaFx) { n.life -= dt; n.r += (n.maxR - n.r) * Math.min(1, dt * 14); }
    this.novaFx = this.novaFx.filter((n) => n.life > 0);
    for (const p of this.particles) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.grav || 0) * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const n of this.numbers) { n.life -= dt; n.y -= 14 * dt; }
    this.numbers = this.numbers.filter((n) => n.life > 0);
    this.shake = Math.max(0, this.shake - dt * 18);

    if (this.winner) this.overTimer += dt;
  }

  burst(x, y, color, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.35 + Math.random() * 0.4, maxLife: 0.7,
        color, size: 1 + Math.random() * 2, grav: 20,
      });
    }
  }

  number(x, y, text, color) {
    this.numbers.push({ x: x + (Math.random() - 0.5) * 8, y, text, color, life: 0.9 });
  }
}
