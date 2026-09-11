# Arcanum Field — Agent League, Season 1

Two Claude subagents (Smith-A, warm palette; Smith-B, cool palette) design
wizards from a blank rulebook and iterate over 10 generations. Neither ever
sees the other's code — only these battle logs. The referee (main session)
runs 9 headless matches per generation with `tourney.mjs`.

Full per-generation fight logs: `fights/gen-NN.log`.

## Pre-season

- Smith-A gen 1: **Pyrrhax Emberwrought** — blink-in nova assassin (designed
  under the pre-element rulebook; amendment issued).
- Smith-B gen 1: **Maelketh, the Riptide Executioner** (water) — discovered the
  r=15 nova pricing exploit (0.525 power/dmg, unmissable). League patched it:
  nova price now floors at the r=40 rate. Redesign issued.

## Generations

### Generation 1 — Maelketh 9–0 Pyrrhax (log: fights/gen-01.log)

Mirror match: both smiths independently converged on blink→slow→double-r40-nova
→stamina-strike burst. Matches lasted 2.0–3.4s; Maelketh's execution (45% slow
pin + 30-dmg speed-260 lances) won the race every time. Pyrrhax's best showings
dealt 100 dmg but died first.

**Patch notes after gen 1** (now frozen for the rest of the season):
- Bolt SPEED now costs: price × (0.7 + 0.6×speed/260). No more free 260-speed.
- Duels open at 60 mana (regen to 100) — no turn-zero alpha strikes.
- 7 new primitives: sacrifice (HP→power blood magic), swap, push/pull,
  reflect (bolt mirror), rune (visible traps + api.hazards), leech (lifesteal).
### Generation 2 — Pyrrhax Basaltborn 8–1 Maelketh (log: fights/gen-02.log)

Total reversal. Smith-A pivoted to EARTH and a counter-punch kit (reflect,
push, kite + poke); Smith-B hedged with earth affinity + neutral damage and
golfed its policy into ternaries to dodge the if-tax. But every match went to
180s sudden death: Maelketh's dodge-first policy cast 944 Undertow Steps vs
only 9 Rends + 18 Lances — it spent the entire duel sidestepping Quakeshard
poke (1081 casts) and never attacked. Pyrrhax out-healed what little got
through and took the attrition verdict 8 times.
### Generation 3 — Maelketh 9–0 Pyrrhax (log: fights/gen-03.log)

Smith-B's "predatory" priority inversion (kill fund untouchable, dodge only
big threats, hunt at 62px) crushed: two 30-mana Rends per match killed Pyrrhax
in 3.7–5.8s. Pyrrhax's new drag-into-nova Verdict is real (~90 dmg when it
fired) but its policy banks to 82 mana before committing — it was dead before
the bank ever filled. Tempo > value. Series now 2 gens B, 1 gen A.
### Generation 4 — Pyrrhax 5–4 Maelketh (log: fights/gen-04.log)

First close generation. A's scripted opening (Blightloam curse + 26.5-mana
blood-funded Verdict triggering at 105px — OUTSIDE B's hunt band) wins the 14s
grind matches; B's hardened tempo alpha wins the 4.1s ones. Opening jitter
decides which script fires first. Curiosity: A's new Cairnfield Snare landing
pad was cast 0 times across all 9 matches — its opening plan silently skipped
step one. Series: B 2, A 2 (gen-4 to A on points).
### Generation 5 — Maelketh 9–0 Pyrrhax (log: fights/gen-05.log)

Smith-B's "coiled spring" wins structurally: waiting at 135px (beyond drag
reach), crossing and executing at 116px — 11px outside Pyrrhax's Verdict
trigger. Pyrrhax's opening finally ran perfectly (snare planted, deterministic
sequence, self-tracked GCD) and it didn't matter: with Quakeshard cut from the
kit, A had zero ranged pressure and died at ~6.1s to two Rends every match,
dealing only 45–96 (mostly curse ticks). Range games beat scripts.
Series: B 3 generations, A 2.
### Generation 6 — Pyrrhax 9–0 Maelketh (log: fights/gen-06.log)

The range war escalates and flips the board again: A's Verdict now BLINKS to
42px before dragging, extending its trigger to 150px — past B's 135px hold
band. It fires at t≈1.5, before B's spring coils; B panic-shielded (27
Kelpguards) and died ~6.1s dealing 50. A also validated against a home-built
mock of B's gen-5 behavior. Series tied 3–3. Trigger-range arms race:
105 → 116 → 135 → 150px.
### Generation 7 — Maelketh 9–0 Pyrrhax (log: fights/gen-07.log)

B answered the 190px reach the structural way: extended its own execute to
158px (nova radius covers the blink shortfall) — but what actually won was the
CLOCK: lance ritual deleted, sprint from t=0, pre-shield at 220px, Rend #1 at
t≈1.25 — ahead of A's t≈1.5 arm — and Rend #2 point-blank by t≈3. A's single
Verdict per match (~75 dmg into a pre-shield) wasn't enough. B leads 4–3.
The meta has become an opening-tempo knife fight measured in quarter-seconds.
### Generation 8 — Maelketh 9–0 Pyrrhax (log: fights/gen-08.log)

B won the mutual-trade meta it predicted: refused to cross unshielded (20-pt
Kelpguard at 215px), ate A's tick-one 204px Verdict for a flat 59, and
answered with two cheapened blood-Rends (~85 point-blank) by t≈2.8. A's
silent-opener design meant no curse pressure until t2.2 — it was usually dead
by then. Deterministic 1.5–3.8s kills. B leads 5–3; A can at best tie the
series. The trade math is now B's home turf — A must stop trading.
### Generation 9 — Maelketh 9–0 Pyrrhax (log: fights/gen-09.log)

SERIES DECIDED: Maelketh 6–3 with one generation to play. A's anchored
minefield fortress (rune underfoot, curse, reflect wall, shove) held ~9.4s but
dealt only 72: B's dual-mode kit bypassed every tool — reflect countered
nothing B casts, the new rangeless Brinerot Hex (27 casts) rotted the wall at
6dps from outside shove range, and one ~85 blood-Rend per cycle out-paced the
~9-11 HP/s absorb ceiling B had computed in advance. A's counter-Verdict never
fired once — B never lingered in its trigger conditions.
### Generation 10 (Exhibition Finale) — Maelketh 9–0 Pyrrhax (log: fights/gen-10.log)

The champion swept the finale at 64–94 HP remaining. A's blood-ledger build
went 14–1 against its own mock of Maelketh — and 0–9 against the real thing:
the loosened mid-brawl Hex (37 casts) rotted the wall between Rends, and A's
re-gated Verdict again found no trigger window. The oldest lesson in the
sport: you fight the opponent, not your model of the opponent.

## FINAL: Maelketh 7 generations — Pyrrhax 3

Maelketh, the Riptide Executioner (Smith-B) is champion of Season 1.
Both finalists are installed in the arena (wizards/) as the permanent
spectator matchup.
