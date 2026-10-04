# BISCAD brand guide

One page. Read it before you make anything with the BISCAD name on it.

## Name

- Write **BISCAD** in all caps. Always. In prose, in code comments, in tweets.
- Say it "biss-cad". One word. No space, no hyphen, no "BisCAD", no "Biscad".
- BISCAD is a CAD kernel API: build123d and OpenCascade behind REST and MCP, plus a web studio.
- BISCAD is priced per build. It is not priced per seat. Say that often.
- Sibling product: **Voncad**, the terminal CAD viewer. Mention it as "from the makers of Voncad".

## Logo

The logo is a horizontal band. A white stripe on top, a thick blood-red stripe in the middle,
a white stripe on the bottom. "BISCAD" sits in the red stripe, set in DM Serif Display. The
letters are so large that the band cuts off the left side of the B and the right side of the D.
The crop is the point. The name is bigger than its container.

| File | Use it for |
|---|---|
| `brand/logo.svg` | The primary logo. Headers, posters, slides, social banners. |
| `brand/logo-mark.svg` | Square app icon, avatar, favicon. A square window onto the band ("BIS"). |
| `brand/wordmark.svg` | Wordmark only, bone on dark UI. Nav bars, footers, small sizes. |
| `brand/wordmark-blood.svg` | Wordmark only, blood bright. Use on bone or white paper. |
| `web/favicon.svg` | Copy of the mark for the site. |
| `brand/logo-candidates.png` | Contact sheet of the 12 faces we tried. Reference only. |

All text in the SVGs is converted to outlines. The files need no fonts.

Geometry (band height = H):

- White stripes: 0.13 H each. Red stripe: 0.74 H.
- Cap height: 0.82 of the red stripe. Letters are centred on the red stripe.
- Crop: 36% of the B ink width is off the left edge. 27% of the D ink width is off the right edge.
  The D keeps more of itself so it still reads as a D and not an I.
- Aspect ratio of `logo.svg`: 1063 × 400 (about 2.66 : 1).

Clear space: keep 0.5 H of empty space on all sides of the band. Minimum size: 96 px wide on
screen, 25 mm wide in print. Below that, use the mark or the wordmark.

Backgrounds: the logo lives on `--void` (near-black). On white paper the white stripes vanish.
On light backgrounds, put the band on a `--void` plate, or use `wordmark-blood.svg`.

## Palette

| Token | Hex | Role |
|---|---|---|
| `--blood` | `#8a0b1a` | Hero colour. The logo stripe, poster fields, primary buttons. |
| `--blood_bright` | `#c1162b` | Accents on dark: links, focus rings, the one word you want read first. |
| `--oxblood` | `#4a0710` | Deep shadows inside red fields, pressed states. |
| `--ember` | `#ff4a3d` | Live state only: errors, recording, "armed". Use rarely. |
| `--void` | `#0a0506` | Page background. Warm near-black, never pure #000. |
| `--char` / `--panel` / `--panel_raised` | `#120c0d` / `#1a1213` / `#231819` | Surfaces, in order of height. |
| `--bone` | `#efe6e1` | Body text and display type on dark. |
| `--stripe_white` | `#f6f1ec` | The logo stripes and letters. Slightly warm white. |
| `--ash` / `--smoke` | `#a3938f` / `#6e605d` | Secondary text / tertiary text and rules. |
| `--brass` | `#c9a36a` | Measurements, dimensions, numbers that matter. Never decoration. |
| `--signal_ok` / `--signal_warn` | `#4fae7c` / `#e0a33a` | Status only. |

Ratio on a page: about 70% void, 20% bone, 10% blood. Red is loud. Use it like a stamp.

## Typography

All fonts are on Google Fonts.

| Role | Face | Notes |
|---|---|---|
| Display serif | **DM Serif Display** | The logo face. Headlines, poster lines, big numbers. Tight tracking (−0.01 em). |
| Display condensed | **Big Shoulders Display** 800–900 | All-caps labels, slogans, "MAKE CAD GREAT AGAIN". Tracking +0.02 em. |
| Body | **IBM Plex Sans** 400/500 | Paragraphs, UI. 16–18 px, line height 1.55. |
| Mono | **IBM Plex Mono** 400/500 | Code, API paths, eyebrows, prices, counters. |

CSS variables: `--display_serif`, `--display`, `--body`, `--mono` in `brand/tokens.css`.

## Voice

Engineer to engineer. Confident. Funny. Short sentences.

- Say the number. "2,000 builds a month, free." Not "generous limits".
- Put units on every number: "0.2 s", "62 mm", "$0".
- One joke per piece. Then the facts.
- Make fun of the business model, never of people. Onshape's engineers built a great product.
  Their pricing page is fair game. Their users are our future users.
- Cite the source for every claim about a competitor. Link the page. Give the date.
- Follow `.construction/how-to-write-prose.md` for docs and UI copy: active voice, one fact per
  sentence, no hype words.

Words we use: build, kernel, part, face id, render, agent, per build, seat.
Words we do not use: revolutionary, game-changing, seamless, leverage, unlock, democratize, magic.

## Do

- Let the band crop. Let headlines run off the edge of posters, as the logo does.
- Use big type and one red field. Leave a lot of near-black.
- Show real parts built with BISCAD. A render beats a claim.
- Quote competitor limits with a link to their own docs.

## Do not

- Do not stretch, skew, outline, recolour or add effects to the logo.
- Do not "fix" the crop by showing the full B and D in the band.
- Do not put the band on busy photos or on mid-tone backgrounds.
- Do not use another company's logo, trade dress or product colours in our ads.
- Do not invent testimonials, user counts, benchmarks or customer names.
- Do not post from any automation. The founder posts, by hand, from `web/launch.html`.
