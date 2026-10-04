# BISCAD launch campaign

Working title: **MAKE CAD GREAT AGAIN.** Red is the brand colour. The joke writes itself.

Gallery of finished creatives: `web/campaign.html`. Launch console (passphrase-gated, the
founder posts by hand): `web/launch.html`. Nothing in this campaign posts automatically.

## 1. Facts we stand on

Every ad uses only these facts. Re-check the two Onshape pages on launch day and update the date.

| Claim | Source | Checked |
|---|---|---|
| Onshape Standard costs $1,500 per user per year. Professional costs $2,500 per user per year. Enterprise is "contact us". A free plan exists for non-commercial use. | [onshape.com/en/pricing](https://www.onshape.com/en/pricing) | 2026-10-04 |
| Onshape API calls per year: Free and Standard 2,500 per user; Professional 5,000 per user; Enterprise 10,000 per full user. | [Onshape developer docs, API limits](https://onshape-public.github.io/docs/auth/limits/) | 2026-10-04 |
| Calls from public Onshape App Store apps (OAuth), browser and mobile clients, and rejected calls (4xx/5xx) do not count toward the limit. | Same page | 2026-10-04 |
| 5,000 calls ÷ 3,600 s = 1.39 calls per second for one hour. An agent loop at that rate uses a Professional seat's yearly calls in about one hour. | Arithmetic | — |
| $2,500 ÷ 5,000 calls = $0.50 per call, if you count only the API. The seat also includes the full Onshape CAD app. Always say so. | Arithmetic | — |
| BISCAD free plan: 2,000 builds per month, 3,600 compute-seconds per month, 120 requests per minute. Anonymous playground: 300 builds per month per IP. | `server/store.py` (`PLANS`) | 2026-10-04 |
| BISCAD does: build123d / OpenCascade builds over REST and MCP; renders as PNG; stable face and edge ids; measure, section, mass, DFM check, diff; exports STEP, STL, GLB, 3MF, BREP, SVG, DXF; STEP/STL import; versions and params; a web studio; build-step replay; design reports. | `README.md`, `PROGRESS.md` | 2026-10-04 |

Rules:

- Paid BISCAD prices are not public yet. Do not print a paid price. Say "priced per build".
- The free-plan numbers are launch defaults. Add "at launch" when space allows.
- The viral post ("on their $2,500/yr professional plan you have an hour of use before you're out
  of calls for the year") is someone else's words. Quote it only with a link to the real post.
  Do not attribute it to a person unless we link them.
- No Onshape logo, no Onshape screenshots, no Onshape colours. Name them in plain text only.
- No Cadbury logo, script, wrapper layout or purple (Pantone 2685C family). Wordplay only. Keep
  "CADbury" to one-off headlines. Never use it as a product or plan name.
- No testimonials, no user counts, no "trusted by". We have none yet. That is fine.

## 2. Positioning

**For** people who build things with code and agents,
**BISCAD is** a CAD kernel you call over HTTP or MCP,
**that** charges per build, not per seat,
**unlike** seat-licensed CAD APIs whose yearly call allowance an agent can spend in an hour.

One line: **The CAD kernel for agents. Priced per build, not per seat.**

Three proof points, always in this order:

1. **Agents can call it.** REST and MCP. `claude mcp add --transport http biscad <host>/mcp`.
2. **Agents can see it.** Every build returns a render, stable face ids and a summary.
3. **You can afford it.** 2,000 builds a month free at launch. Then pay per build.

## 3. Audiences

| Audience | What hurts | What we say | Where they are |
|---|---|---|---|
| **AI-agent builders** (MCP servers, coding agents, text-to-CAD demos) | Per-seat CAD APIs meter calls per year. Agents make calls per second. | "Your agent doesn't need a seat." MCP in one command. Renders the agent can look at. | X, HN, Discord (MCP, Claude, Cursor), GitHub |
| **Hardware startups and makers** (3D printing, small-batch CNC, robotics) | They need parametric parts in a pipeline, and STEP/STL out, without a $1,500+ per-seat bill. | "Snap-fit, not lock-in." Scripts in, STEP/3MF out. Free tier covers a side project. | r/3Dprinting, r/functionalprint, Product Hunt, YouTube |
| **Mechanical engineers tired of seat licences** | Licence true-ups, seat audits, "talk to sales". | "Seats are for stadiums." build123d is Python. The kernel is OpenCascade. Your geometry exports as STEP. | LinkedIn, r/cad, r/MechanicalEngineering, newsletters |

## 4. Ad concepts

Each concept lists headline, subline and visual direction. Format tags: **1:1** feed,
**9:16** story/reel, **16:9** banner/header. All twelve live as designed cards in `web/campaign.html`.

### 01 · Make CAD Great Again — 1:1, 9:16
- **Headline:** MAKE CAD GREAT AGAIN
- **Subline:** Per build. Not per seat.
- **Visual:** Full blood field. Big Shoulders 900 caps stacked three lines, white, running off the
  right edge like the logo crop. Logo band at the bottom. No hats, no flags, no politicians.

### 02 · An hour a year — 16:9, 1:1
- **Headline:** One hour. Per year.
- **Subline:** Onshape Professional includes 5,000 API calls per user per year. An agent at 1.4
  calls/s uses them in about 60 minutes. BISCAD bills per build.
- **Visual:** A huge brass "59:59" stopwatch readout in mono on void. A thin red progress bar,
  empty. Footnote with the docs URL and date.

### 03 · The long division — 1:1
- **Headline:** $2,500 ÷ 5,000 = $0.50
- **Subline:** That is the seat price divided by its yearly API calls. (The seat also includes
  the CAD app. We are just doing the maths.)
- **Visual:** School-style long division in DM Serif Display, bone on void. The quotient in
  blood bright. Pencil-thin brass dimension lines.

### 04 · CADbury — 1:1, 9:16
- **Headline:** CADbury your seat licence.
- **Subline:** Every square is a build. Snap off as many as you need.
- **Visual:** A chocolate bar drawn as a 4 × 6 grid of chamfered CAD blocks, oxblood and blood,
  lit from the top left. Our logo band is the wrapper. No purple, no script.

### 05 · Never sits down — 9:16, 1:1
- **Headline:** Your agent doesn't need a seat.
- **Subline:** It never sits down. BISCAD charges per build.
- **Visual:** An empty office chair in outline, struck through with one red stroke. Below it, a
  terminal line: `claude mcp add --transport http biscad …/mcp`.

### 06 · Seats are for stadiums — 16:9
- **Headline:** Seats are for stadiums.
- **Subline:** CAD kernel over REST and MCP. Priced per build.
- **Visual:** Rows of stadium seats as a halftone grid of tiny squares, all grey except one red
  square labelled "you, paying per build".

### 07 · It's February — 9:16
- **Headline:** API calls remaining this year: 0
- **Subline:** It's February. (Not with BISCAD.)
- **Visual:** A phone notification card, system-UI style, generic, no brand marks. Date stamp
  "Feb 3". Under it, a BISCAD toast: "Build 4,812 ok · 0.4 s".

### 08 · Talk to /v1/build — 16:9, 1:1
- **Headline:** Talk to sales? Talk to /v1/build.
- **Subline:** One POST. A solid, a render, and face ids back.
- **Visual:** A code card with a real curl call to `POST /v1/build`, syntax in bone, brass and
  blood bright. The JSON response peeks out below.

### 09 · Face ids that stay put — 1:1
- **Headline:** p0/f7 is still p0/f7.
- **Subline:** Stable face ids across rebuilds. Your agent can point at geometry and mean it.
- **Visual:** An isometric bracket drawn in thin bone lines. One face filled blood, labelled
  `p0/f7` with a brass leader line.

### 10 · Snap-fit, not lock-in — 1:1, 16:9
- **Headline:** Snap-fit, not lock-in.
- **Subline:** STEP, STL, 3MF, GLB, BREP, SVG, DXF. Your geometry leaves when you do.
- **Visual:** A snap-fit cantilever hook in section, drawn like an engineering drawing, with the
  seven file extensions as callouts.

### 11 · Rest in pieces — 9:16
- **Headline:** Rest in pieces, per-seat pricing.
- **Subline:** It had a good run. Survived by per-build billing.
- **Visual:** A tombstone in flat bone with DM Serif lettering. A small red flower. Funny, not
  cruel. No company named on the stone.

### 12 · The fine print is the big print — 16:9, 9:16
- **Headline:** 2,000 builds a month. Free.
- **Subline:** The fine print, in big print: 120 requests/min, 60 s per build, at launch.
- **Visual:** The number 2,000 in DM Serif at 60% of canvas height, cropped by the bottom edge.

### 13 · Your agent can see — 1:1
- **Headline:** Look before you cut.
- **Subline:** Every build returns a PNG render. Agents check the part before they ship it.
- **Visual:** A rendered part as a crisp PNG tile with a small eye glyph and the API path
  `GET /v1/versions/{id}/render.png`.

### 14 · Choc-full of geometry — 1:1
- **Headline:** Choc-full of geometry.
- **Subline:** Fillets, chamfers, lofts, sweeps, shells. All build123d. All over HTTP.
- **Visual:** A single chocolate square, filleted, sectioned to show layers, labelled with
  operation names in mono.

## 5. Launch plan

Launch day is a Tuesday. Post between 15:00 and 16:00 UTC (morning in the US, afternoon in
Europe). The founder posts every item by hand from `web/launch.html`. Before launch day, replace
`https://biscad.dev` with the real public URL in the console's URL field.

### 5.1 Hacker News (Show HN)

**Title:** Show HN: BISCAD – a CAD kernel API for agents, priced per build instead of per seat

**URL:** the landing page.

**First comment (post it right after submitting):**

> Hi HN. I built BISCAD, a hosted CAD kernel. It is build123d and OpenCascade behind a REST API
> and an MCP server, with a web studio for humans to check what agents make.
>
> Why: I wanted an agent to iterate on parts in a loop. Onshape's API docs list 2,500 to 10,000
> API calls per user per year, depending on plan (https://onshape-public.github.io/docs/auth/limits/).
> An agent loop can make that many calls in an hour. Their seats include a lot more than the API,
> so this is not a dunk on the product. It is a different shape of pricing for a different user.
>
> What it does today:
> - POST a build123d script, get a solid, a PNG render, stable face/edge ids and a summary
> - measure, section, mass, DFM checks, diff between versions
> - export STEP, STL, 3MF, GLB, BREP, SVG, DXF; import STEP/STL
> - MCP: `claude mcp add --transport http biscad <host>/mcp`
> - build-step replay and HTML design reports, so a human can review an agent's part
>
> Free plan at launch: 2,000 builds/month. Builds run in a sandboxed subprocess with resource
> limits. It is early. I would like to hear what breaks, and what you would use it for.
>
> From the maker of Voncad, a terminal CAD viewer.

### 5.2 X / Twitter thread

Reply in the spirit of the viral "an hour of use" post. Quote-tweet it if you can link it.

1. > On a $2,500/yr Onshape Professional seat you get 5,000 API calls a year.
   > An agent at 1.4 calls/s spends that in about an hour.
   > So I built a CAD kernel that charges per build. A thread:
2. > BISCAD = build123d + OpenCascade behind REST and MCP.
   > POST a script. Get back a solid, a PNG render, stable face ids and a mass summary.
3. > Agents can see what they built. Every build returns an image. They check the part before
   > they cut it.
4. > One line to add it to Claude Code:
   > `claude mcp add --transport http biscad https://biscad.dev/mcp`
5. > Export STEP, STL, 3MF, GLB, BREP, SVG, DXF. Your geometry leaves when you do.
6. > Free at launch: 2,000 builds/month. Paid plans: per build, not per seat.
   > Make CAD great again → https://biscad.dev
7. > Sources, because receipts matter:
   > Onshape API limits: https://onshape-public.github.io/docs/auth/limits/
   > Onshape pricing: https://www.onshape.com/en/pricing

### 5.3 LinkedIn

> Per-seat pricing made sense when one engineer sat at one workstation.
>
> AI agents don't sit. They loop. An agent that designs a bracket might call a CAD API
> hundreds of times in an hour.
>
> Onshape's developer docs list 2,500 to 10,000 API calls per user per year, depending on plan.
> That is fine for a human clicking buttons. It is about an hour for an agent.
>
> So we built BISCAD: an OpenCascade / build123d CAD kernel behind a REST API and an MCP server.
> It is priced per build. The free plan includes 2,000 builds a month at launch.
>
> Every build returns a render, stable face ids and a summary, so engineers can review what an
> agent made before it ships. Exports: STEP, STL, 3MF, GLB, BREP, SVG, DXF.
>
> If you build hardware with code, or agents that build hardware, I would like your feedback.
>
> https://biscad.dev

### 5.4 Product Hunt

- **Name:** BISCAD
- **Tagline (60 chars max):** The CAD kernel for agents. Per build, not per seat.
- **Description (260 chars max):** BISCAD is build123d and OpenCascade behind a REST API and an
  MCP server. Send a script, get a solid, a render, stable face ids and STEP/STL/3MF exports.
  Built for AI agents that iterate fast. 2,000 builds/month free at launch.
- **Topics:** Developer Tools, Artificial Intelligence, Hardware, API.
- **Maker comment:** use the HN first comment, shorter, with one image of the studio.
- **Gallery:** cards 01, 02, 08, 09, 12 from `web/campaign.html` at 16:9, plus a studio screenshot.

### 5.5 Reddit

Check each subreddit's self-promotion rules on the day. Post as the founder, answer every comment,
and do not cross-post the same text within one hour.

**r/cad** — *Title:* I built a hosted build123d/OpenCascade kernel with a REST API and MCP server.
Free tier, per-build pricing. Feedback wanted.

> I make Voncad (a terminal CAD viewer). BISCAD is the server side: you POST a build123d script and
> get a solid, a PNG render, face/edge ids, mass properties and exports (STEP, STL, 3MF, GLB, BREP,
> SVG, DXF). There is a web studio too. I built it because seat-licensed CAD APIs cap API calls per
> year (Onshape's docs list 2,500–10,000 per user), and agents burn through that fast. Free plan is
> 2,000 builds/month at launch. What would you need before you trusted it in a real workflow?

**r/3Dprinting** (or r/functionalprint) — *Title:* Parametric parts from a URL: change a number,
get a new STL/3MF back

> Scripts can define params, e.g. `params = {"width": 40}`. Call the API with a new width and
> download a fresh STL or 3MF. There is a DFM check for FDM too. It runs on build123d/OpenCascade
> and the free tier is 2,000 builds a month. Happy to share the bracket script from the screenshot.

### 5.6 30-second video script

| Time | Picture | Sound / text |
|---|---|---|
| 0–3 s | Black. The logo band slides in. The B and D are cut off by the frame. | Low synth hit. |
| 3–8 s | A stopwatch counts 00:00 → 59:59 at speed. Caption: "5,000 API calls/year". | VO: "Some CAD APIs give you a year of calls." |
| 8–11 s | The stopwatch stops. Caption: "Agent at 1.4 calls/s". | VO: "Your agent needs about an hour." |
| 11–18 s | Screen recording: Claude Code adds the BISCAD MCP server; the agent builds a bracket; the studio shows the part turning. | VO: "BISCAD is a CAD kernel your agent calls. It sees the render. It fixes the fillet." |
| 18–24 s | Fast cuts: face id `p0/f7` highlighted; section view; STEP and 3MF downloads. | VO: "Stable face ids. Sections. Mass. STEP out." |
| 24–28 s | Red field. "MAKE CAD GREAT AGAIN" in white caps. | VO: "Priced per build. Not per seat." |
| 28–30 s | Logo band. URL. Small footnote with the Onshape docs URL and date. | Synth hit out. |

## 6. Calendar

| Day | Date (example) | What | Channel |
|---|---|---|---|
| T−14 | Tue | Pick the public URL. Re-check the facts table. Freeze copy. | — |
| T−10 | Sat | Record the 30 s video. Export cards from `web/campaign.html`. | — |
| T−7 | Tue | Teaser: card 01 (Make CAD Great Again), no link. | X, LinkedIn |
| T−5 | Thu | Teaser: card 02 (One hour per year) with sources. | X |
| T−3 | Sat | Prepare Product Hunt draft. Schedule for T 00:01 PT. | Product Hunt |
| T−1 | Mon | Dry run of the launch console. Open each composer, cancel. Test sign-ups. | — |
| **T** | **Tue 15:00 UTC** | Show HN post + first comment. X thread. LinkedIn post. PH goes live. | HN, X, LinkedIn, PH |
| T | Tue 18:00 UTC | Answer every HN and PH comment. No vote asks. | HN, PH |
| T+1 | Wed | r/cad post. Card 09 (face ids). | Reddit, X |
| T+2 | Thu | r/3Dprinting or r/functionalprint post. Card 10 (snap-fit). | Reddit, X |
| T+3 | Fri | Video on X, LinkedIn, YouTube Shorts. | X, LinkedIn, YouTube |
| T+7 | Tue | "What we learned in week 1" thread with real numbers only. Card 04 (CADbury). | X, LinkedIn |
| T+14 | Tue | Card 11 (Rest in pieces). Changelog post. | X |

Do not ask anyone to upvote. HN and Product Hunt both penalise vote rings.
