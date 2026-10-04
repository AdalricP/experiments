"""Human oversight of agent-made CAD: an animated build explainer (GIF) and an HTML design
report. The point (per Karpathy): people should *understand* model output at a glance, not
read a wall of numbers."""
from __future__ import annotations

import base64
import html
import io
import json
import math
import os

from PIL import Image, ImageDraw

import render as R


def _caption(img, title, text, idx=None, total=None):
    W, H = img.size
    bar = 64
    out = Image.new("RGB", (W, H + bar), "#ffffff")
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    d.line([(0, H), (W, H)], fill=(225, 225, 225))
    f1, f2 = R._font(13), R._font(12)
    if idx is not None and total:
        d.rectangle((0, H, int(W * (idx + 1) / total), H + 2), fill=(26, 26, 26))
    d.text((16, H + 12), title.upper(), fill=(26, 26, 26), font=f1)
    # wrap description
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        if d.textlength(cur + " " + w_, font=f2) > W - 32:
            lines.append(cur)
            cur = w_
        else:
            cur = (cur + " " + w_).strip()
    lines.append(cur)
    for k, ln in enumerate(lines[:2]):
        d.text((16, H + 32 + k * 15), ln, fill=(94, 94, 94), font=f2)
    return out


def explainer_gif(vdir: str, w=560, h=400) -> bytes:
    steps = json.load(open(os.path.join(vdir, "steps.json"))) if os.path.exists(os.path.join(vdir, "steps.json")) else []
    frames, durations = [], []
    total = len(steps)
    for st in steps:
        sdir = os.path.join(vdir, "steps", str(st["index"]))
        if not st.get("has_scene") or not os.path.exists(os.path.join(sdir, "mesh.npz")):
            continue
        img = R.render(sdir, "iso", w, h, frame=vdir, as_image=True)
        frames.append(_caption(img, f"Step {st['index'] + 1} / {total} · {st.get('label', st['op'])}", st["description"], st["index"], total))
        durations.append(1400)
    # final assembly, then a turntable
    final = R.render(vdir, "iso", w, h, as_image=True)
    frames.append(_caption(final, "Result", "The finished model, as exported to STEP.", total - 1 if total else None, total))
    durations.append(1600)
    for k in range(1, 24):
        a = math.radians(-45 + k * 15)
        v = (math.cos(a) * 1.41, math.sin(a) * 1.41, 0.8)
        img = R.render(vdir, v, w, h, edges=True, as_image=True)
        frames.append(_caption(img, "Result", "Turntable view.", None, None))
        durations.append(90)
    pal = [f.convert("P", palette=Image.ADAPTIVE, colors=128) for f in frames]
    b = io.BytesIO()
    pal[0].save(b, "GIF", save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True)
    return b.getvalue()


def _png_b64(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode()


def report_html(vdir: str, version: dict, doc: dict | None, mass_al: dict, dfm: dict) -> str:
    s = version.get("summary") or {}
    esc = html.escape
    name = esc((doc or {}).get("name") or "Untitled model")
    views = {v: _png_b64(R.render(vdir, v, 520, 400)) for v in ("iso", "front", "top", "right")}
    labelled = _png_b64(R.render(vdir, "iso", 900, 640, labels=True))
    steps = version.get("steps") or []
    step_html = []
    for st in steps:
        sdir = os.path.join(vdir, "steps", str(st["index"]))
        thumb = ""
        if st.get("has_scene") and os.path.exists(os.path.join(sdir, "mesh.npz")):
            thumb = f'<img src="{_png_b64(R.render(sdir, "iso", 260, 190, frame=vdir))}" alt="">'
        line = f' · line {st["line"]}' if st.get("line") else ""
        step_html.append(f'<li><div class="thumb">{thumb}</div><div><span class="label">Step {st["index"] + 1} · '
                         f'{esc(st.get("label", st["op"]))}{line}</span><p>{esc(st["description"])}</p></div></li>')
    parts_rows = "".join(
        f'<tr><td>{esc(p["id"])}</td><td>{esc(p["name"])}</td><td>{p["volume"]:,.1f}</td>'
        f'<td>{" × ".join(f"{x:.1f}" for x in p["bbox"]["size"])}</td><td>{p["faces"]}</td>'
        f'<td>{"yes" if p["valid"] else "<b>no</b>"}</td></tr>' for p in s.get("parts", []))
    params = version.get("params") or {}
    schema = version.get("param_schema") or []
    prm_rows = "".join(f'<tr><td>{esc(p["name"])}</td><td>{esc(str(params.get(p["name"], p["default"])))}</td>'
                       f'<td>{esc(str(p["default"]))}</td></tr>' for p in schema)
    issues = dfm.get("issues", [])
    dfm_rows = "".join(f'<li class="{esc(i["severity"])}"><span class="label">{esc(i["severity"])} · {esc(i["code"])}</span>'
                       f'<p>{esc(i["message"])}</p>{"<code>" + esc(", ".join(i.get("refs", [])[:12])) + "</code>" if i.get("refs") else ""}</li>'
                       for i in issues) or '<li><p>No manufacturability issues found for FDM printing.</p></li>'
    mass_rows = "".join(f'<tr><td>{m}</td><td>{s.get("mass_g_" + k, 0):,.1f} g</td></tr>'
                        for m, k in (("Steel (7.85 g/cm³)", "steel"), ("Aluminium (2.70 g/cm³)", "aluminium"), ("PLA (1.24 g/cm³)", "pla")))
    bb = s.get("bbox", {"min": [0, 0, 0], "max": [0, 0, 0]})
    size = [b - a for a, b in zip(bb["min"], bb["max"])]
    vid = esc(version["id"])
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} — Design report</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=Michroma&display=swap" rel="stylesheet">
<style>
:root{{--text:#121212;--muted:#5e5e5e;--line:rgba(0,0,0,.09);--bg:#fff}}
@media (prefers-color-scheme:dark){{:root:not([data-theme=light]){{--bg:#fff}}}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--text);font:15px/1.6 Geist,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
.wrap{{max-width:1100px;margin:0 auto;padding:0 20px}}
header{{padding:48px 0 24px;text-align:center}}
.wm{{font-family:Michroma,sans-serif;font-size:13px;letter-spacing:.62em;margin-right:-.62em}}
h1{{font-family:Michroma,sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:.04em;font-size:clamp(22px,3.4vw,36px);margin-top:28px}}
.label{{font-size:11px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}}
section{{padding:48px 0;border-top:1px solid var(--line)}}
h2{{font-size:24px;font-weight:500;letter-spacing:-.02em;margin:6px 0 20px}}
.stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-top:28px}}
.stat{{padding:24px 8px;text-align:center}}.stat+.stat{{border-left:1px solid var(--line)}}
.stat b{{display:block;font-family:Michroma,sans-serif;font-weight:400;font-size:18px}}
.views{{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}}
.views figure{{background:#fff;padding:8px}}.views img{{width:100%;display:block}}
figcaption{{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);text-align:center}}
.big{{width:100%;border:1px solid var(--line)}}
table{{width:100%;border-collapse:collapse;font-size:14px}}td,th{{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}}
th{{font-weight:500;color:var(--muted);font-size:12px;letter-spacing:.12em;text-transform:uppercase}}
ol.steps{{list-style:none;display:grid;gap:0}}ol.steps li{{display:grid;grid-template-columns:150px 1fr;gap:20px;padding:16px 0;border-bottom:1px solid var(--line);align-items:center}}
.thumb img{{width:150px;display:block}}
ul.dfm{{list-style:none}}ul.dfm li{{padding:14px 0;border-bottom:1px solid var(--line)}}ul.dfm li.error .label{{color:#b3261e}}ul.dfm li.warning .label{{color:#8a5a00}}
code,pre{{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}}pre{{background:#f6f6f5;padding:16px;overflow:auto;border:1px solid var(--line)}}
code{{color:var(--muted)}}
footer{{text-align:center;padding:40px 0 60px;font-size:12px;color:#9a9a9a}}
@media (max-width:600px){{ol.steps li{{grid-template-columns:96px 1fr}}.thumb img{{width:96px}}.stat+.stat{{border-left:0}}}}
</style></head><body>
<header class="wrap"><div class="wm">BISCAD</div><h1>{name}</h1>
<p class="label" style="margin-top:10px">Design report · version {vid}</p>
<div class="stats">
<div class="stat"><b>{size[0]:.1f} × {size[1]:.1f} × {size[2]:.1f}</b><span class="label">Size mm</span></div>
<div class="stat"><b>{s.get("volume", 0) / 1000:,.2f}</b><span class="label">Volume cm³</span></div>
<div class="stat"><b>{len(s.get("parts", []))}</b><span class="label">Parts</span></div>
<div class="stat"><b>{len(steps)}</b><span class="label">Build steps</span></div>
</div></header>
<main class="wrap">
<section><span class="label">Views</span><h2>What was built</h2><div class="views">
{''.join(f'<figure><img src="{src}" alt="{v} view"><figcaption>{v}</figcaption></figure>' for v, src in views.items())}
</div></section>
<section><span class="label">References</span><h2>Face ids, as the API and agents see them</h2>
<img class="big" src="{labelled}" alt="labelled faces"></section>
<section><span class="label">Build steps</span><h2>How it was built</h2><ol class="steps">{''.join(step_html) or '<li><div></div><p>This model was built without BuildPart steps (algebra mode).</p></li>'}</ol></section>
<section><span class="label">Parts</span><h2>Bill of materials</h2>
<table><tr><th>Id</th><th>Name</th><th>Volume mm³</th><th>Size mm</th><th>Faces</th><th>Valid</th></tr>{parts_rows}</table></section>
<section><span class="label">Mass</span><h2>Mass by material</h2><table>{mass_rows}</table>
<p class="label" style="margin-top:16px">Centre of mass {esc(str(s.get("center_of_mass")))}</p></section>
<section><span class="label">Manufacturability</span><h2>FDM check</h2><ul class="dfm">{dfm_rows}</ul></section>
{f'<section><span class="label">Parameters</span><h2>Configuration</h2><table><tr><th>Name</th><th>Value</th><th>Default</th></tr>{prm_rows}</table></section>' if prm_rows else ''}
<section><span class="label">Source</span><h2>Program</h2><pre>{esc(version.get("script") or "")}</pre></section>
</main><footer>Generated by BISCAD</footer></body></html>"""
