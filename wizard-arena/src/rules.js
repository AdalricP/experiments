// Shared duel rules. Both players get identical stats; only their
// LLM-authored spellbooks and policies differ.
export const RULES = {
  W: 480, H: 270,                 // internal pixel resolution
  ARENA: { x: 24, y: 46, w: 432, h: 200 },

  MAX_HP: 100,
  MAX_MANA: 100,
  START_MANA: 60,                 // duels open below full mana — no turn-zero alpha strike
  MAX_STAMINA: 100,

  HP_REGEN: 0.6,                  // per second
  MANA_REGEN: 7,                  // per second
  STAMINA_REGEN: 12,              // per second

  HEAL_RATE_CAP: 5,               // max HP/s recoverable via spells

  MOVE_SPEED: 62,                 // px per second
  RADIUS: 6,

  MAX_SPELLS: 4,
  // Structural pricing: an incantation is priced as a composition of parts.
  SPELL_BASE_COST: 4,             // mana
  SPELL_COST_PER_CHAR: 0.04,      // mana per incantation character
  SPELL_COST_PER_IF: 0.8,         // each `if (`
  SPELL_COST_PER_LOOP: 2.5,       // each `for (` / `while (`
  SPELL_COST_PER_CALL: 0.6,       // each ctx.* primitive call site
  MAX_INCANT_CHARS: 900,
  POWER_PER_MANA: 2.2,            // cast budget = manaCost * this
  AFFINITY_DISCOUNT: 0.85,        // spells of your own element cost ×0.85 mana
  SPELL_COOLDOWN: 0.8,            // per-spell, seconds
  GLOBAL_COOLDOWN: 0.35,

  // Elemental wheel: attacker's spell element vs DEFENDER'S AFFINITY.
  ELEMENTS: ["fire", "water", "earth", "air", "light", "dark"],
  STRONG: { fire: "air", air: "earth", earth: "water", water: "fire", light: "dark", dark: "light" },
  ELEM_STRONG_MULT: 1.3,          // your element beats their affinity
  ELEM_WEAK_MULT: 0.75,           // their affinity beats your element
  ELEM_SAME_MULT: 0.8,            // attuned resistance to your own element
  // neutral (no element) is always ×1.0 and gets no discount

  // Logarithmic-style healing: HP granted = request / (1 + recentHealing/8);
  // recentHealing decays over time. No hard cap — diminishing returns.
  HEAL_FALLOFF: 8,
  HEAL_DECAY: 3,                  // recentHealing lost per second

  POLICY_TICK: 0.25,              // seconds between policy decisions
  POLICY_BASE_STAMINA: 0.9,       // stamina per tick
  POLICY_STAMINA_PER_CHAR: 0.0035,// stamina per policy character per tick
  POLICY_STAMINA_CAP: 4,          // hard cap per tick — no mega-policies
  MAX_POLICY_CHARS: 4000,

  // Winded: when stamina bottoms out, the wizard is spent until it refills.
  WINDED: {
    THRESHOLD: 8,                 // stamina at/below this → winded
    SPEED_MULT: 0.45,             // movement crawl while winded
    HP_DRAIN: 0.5,                // HP lost per second while winded
    MANA_DRAIN: 2.0,              // mana lost per second while winded
  },

  // primitive budget prices (power units) — magical primitives spend the
  // cast's power budget; physical primitives (strike, lunge) spend STAMINA.
  PRICE: {
    BOLT_PER_DMG: 1.0,
    NOVA_PER_DMG_R40: 1.4,        // scaled by radius/40
    HEAL_PER_HP: 1.8,             // charged on HP actually granted
    SHIELD_PER_HP: 1.4,
    BLINK_PER_PX: 0.15,
    HASTE_PER_PCT_SEC: 0.06,
    CURSE_PER_DMG: 1.2,           // total dot damage
    SLOW_PER_PCT_SEC: 0.07,
    STRIKE_STAMINA_PER_DMG: 1.1,  // physical: stamina, not budget
    LUNGE_STAMINA_PER_PX: 0.3,    // physical: stamina, not budget
    SACRIFICE_POWER_PER_HP: 3.0,  // blood magic: 1 HP → 3 power units
    SWAP_FLAT: 20,                // position swap with the enemy
    PUSH_PER_PX: 0.35,            // displace the enemy
    REFLECT_PER_SEC: 12,          // projectile-reflection ward
    RUNE_PER_DMG_R40: 1.1,        // trap rune, radius-floored like novas
    LEECH_PER_PCT_SEC: 0.12,      // lifesteal buff
  },
  BOLT_DMG_MAX: 30,
  NOVA_R_MAX: 70,
  SHIELD_MAX: 40,
  SHIELD_DECAY: 6,                // shield HP lost per second
  BLINK_MAX_PX: 120,
  STRIKE_RANGE: 26,               // px — melee only
  STRIKE_DMG_MAX: 18,
  STRIKE_SHIELD_PIERCE: 0.5,      // physical hits ignore half the shield
  LUNGE_MAX_PX: 55,
  CURSE_DPS_MAX: 6,
  CURSE_SEC_MAX: 6,
  SLOW_PCT_MAX: 50,
  SLOW_SEC_MAX: 4,
  SACRIFICE_MAX_HP: 25,           // max HP burnable per cast
  SACRIFICE_FLOOR: 5,             // blood magic can't take you below this HP
  PUSH_MAX_PX: 60,
  REFLECT_MAX_SEC: 2,
  RUNE_DMG_MAX: 25,
  RUNE_LIFE: 8,                   // seconds before an untriggered rune fades
  RUNES_MAX: 3,                   // active runes per wizard
  LEECH_PCT_MAX: 40,
  LEECH_SEC_MAX: 4,
  CALLS_PER_CAST: 60,             // max primitive calls per incantation run
};

// Structural analysis of a piece of LLM-written code.
export function analyze(src) {
  return {
    chars: src.length,
    ifs: (src.match(/\bif\s*\(/g) || []).length,
    loops: (src.match(/\b(?:for|while)\s*\(/g) || []).length,
    calls: (src.match(/\bctx\.\w+\s*\(/g) || []).length,
  };
}

export function spellManaCost(incantation, affinityMatch = false) {
  const a = analyze(incantation);
  let cost = RULES.SPELL_BASE_COST +
    RULES.SPELL_COST_PER_CHAR * a.chars +
    RULES.SPELL_COST_PER_IF * a.ifs +
    RULES.SPELL_COST_PER_LOOP * a.loops +
    RULES.SPELL_COST_PER_CALL * a.calls;
  if (affinityMatch) cost *= RULES.AFFINITY_DISCOUNT;
  return Math.round(cost * 10) / 10;
}

export function policyStaminaCost(policySrc) {
  const a = analyze(policySrc);
  return Math.min(
    RULES.POLICY_STAMINA_CAP,
    RULES.POLICY_BASE_STAMINA +
      0.0022 * a.chars + 0.06 * a.ifs + 0.2 * a.loops
  );
}

export function elementMult(spellElem, defenderAffinity) {
  if (!spellElem || spellElem === "neutral") return 1;
  if (spellElem === defenderAffinity) return RULES.ELEM_SAME_MULT;
  if (RULES.STRONG[spellElem] === defenderAffinity) return RULES.ELEM_STRONG_MULT;
  if (RULES.STRONG[defenderAffinity] === spellElem) return RULES.ELEM_WEAK_MULT;
  return 1;
}
