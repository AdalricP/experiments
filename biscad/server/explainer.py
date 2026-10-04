from __future__ import annotations

import base64
import html
import io
import json
import math
import os

from PIL import Image, ImageDraw

import render

CAPTION_BAR_HEIGHT_IN_PIXELS = 64
STEP_FRAME_DURATION_IN_MILLISECONDS = 1400
RESULT_FRAME_DURATION_IN_MILLISECONDS = 1600
TURNTABLE_FRAME_DURATION_IN_MILLISECONDS = 90
TURNTABLE_FRAME_COUNT = 23
TURNTABLE_STEP_IN_DEGREES = 15
GIF_PALETTE_COLOR_COUNT = 128
REPORT_VIEW_NAMES = ("iso", "front", "top", "right")
REPORT_MASS_MATERIALS = (("Steel (7.85 g/cm³)", "steel"), ("Aluminium (2.70 g/cm³)", "aluminium"),
                         ("PLA (1.24 g/cm³)", "pla"))


def _wrap_words_to_width(draw, text: str, font, max_width_in_pixels: int) -> list[str]:
    lines, current_line = [], ""
    for word in text.split():
        if draw.textlength(current_line + " " + word, font=font) > max_width_in_pixels:
            lines.append(current_line)
            current_line = word
            continue
        current_line = (current_line + " " + word).strip()
    return lines + [current_line]


def _add_caption_bar(image, title: str, text: str, step_index=None, step_total=None):
    image_width, image_height = image.size
    captioned = Image.new("RGB", (image_width, image_height + CAPTION_BAR_HEIGHT_IN_PIXELS), "#ffffff")
    captioned.paste(image, (0, 0))
    draw = ImageDraw.Draw(captioned)
    draw.line([(0, image_height), (image_width, image_height)], fill=(225, 225, 225))
    title_font, text_font = render.load_monospace_font(13), render.load_monospace_font(12)
    if step_index is not None and step_total:
        draw.rectangle((0, image_height, int(image_width * (step_index + 1) / step_total), image_height + 2), fill=(26, 26, 26))
    draw.text((16, image_height + 12), title.upper(), fill=(26, 26, 26), font=title_font)
    for line_index, line in enumerate(_wrap_words_to_width(draw, text, text_font, image_width - 32)[:2]):
        draw.text((16, image_height + 32 + line_index * 15), line, fill=(94, 94, 94), font=text_font)
    return captioned


def _load_steps(version_directory: str) -> list[dict]:
    steps_path = os.path.join(version_directory, "steps.json")
    if not os.path.exists(steps_path):
        return []
    with open(steps_path) as steps_file:
        return json.load(steps_file)


def _step_directory_if_renderable(version_directory: str, step: dict) -> str | None:
    step_directory = os.path.join(version_directory, "steps", str(step["index"]))
    is_renderable = step.get("has_scene") and os.path.exists(os.path.join(step_directory, "mesh.npz"))
    return step_directory if is_renderable else None


def _step_frames(version_directory: str, width_in_pixels: int, height_in_pixels: int) -> list:
    steps = _load_steps(version_directory)
    frames = []
    for step in steps:
        step_directory = _step_directory_if_renderable(version_directory, step)
        if step_directory is None:
            continue
        image = render.render_version_image(step_directory, "iso", width_in_pixels, height_in_pixels,
                                            framing_directory=version_directory)
        title = f"Step {step['index'] + 1} / {len(steps)} · {step.get('label', step['op'])}"
        frames.append((_add_caption_bar(image, title, step["description"], step["index"], len(steps)),
                       STEP_FRAME_DURATION_IN_MILLISECONDS))
    final_image = render.render_version_image(version_directory, "iso", width_in_pixels, height_in_pixels)
    final_caption = _add_caption_bar(final_image, "Result", "The finished model, as exported to STEP.",
                                     len(steps) - 1 if steps else None, len(steps))
    return frames + [(final_caption, RESULT_FRAME_DURATION_IN_MILLISECONDS)]


def _turntable_frame(version_directory: str, frame_number: int, width_in_pixels: int, height_in_pixels: int):
    angle_in_radians = math.radians(-45 + frame_number * TURNTABLE_STEP_IN_DEGREES)
    view_direction = (math.cos(angle_in_radians) * 1.41, math.sin(angle_in_radians) * 1.41, 0.8)
    image = render.render_version_image(version_directory, view_direction, width_in_pixels, height_in_pixels, edges=True)
    return _add_caption_bar(image, "Result", "Turntable view.", None, None), TURNTABLE_FRAME_DURATION_IN_MILLISECONDS


def build_explainer_gif(version_directory: str, width_in_pixels=560, height_in_pixels=400) -> bytes:
    frames_with_durations = _step_frames(version_directory, width_in_pixels, height_in_pixels) + [
        _turntable_frame(version_directory, frame_number, width_in_pixels, height_in_pixels)
        for frame_number in range(1, TURNTABLE_FRAME_COUNT + 1)]
    palette_frames = [frame.convert("P", palette=Image.ADAPTIVE, colors=GIF_PALETTE_COLOR_COUNT)
                      for frame, _duration in frames_with_durations]
    gif_buffer = io.BytesIO()
    palette_frames[0].save(gif_buffer, "GIF", save_all=True, append_images=palette_frames[1:],
                           duration=[duration for _frame, duration in frames_with_durations], loop=0, optimize=True)
    return gif_buffer.getvalue()


def _png_data_uri(png_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode()


def _report_step_item(version_directory: str, step: dict) -> str:
    step_directory = _step_directory_if_renderable(version_directory, step)
    thumbnail = (f'<img src="{_png_data_uri(render.render_version_png(step_directory, "iso", 260, 190, framing_directory=version_directory))}" alt="">'
                 if step_directory else "")
    line_suffix = f' · line {step["line"]}' if step.get("line") else ""
    return (f'<li><div class="thumb">{thumbnail}</div><div><span class="label">Step {step["index"] + 1} · '
            f'{html.escape(step.get("label", step["op"]))}{line_suffix}</span><p>{html.escape(step["description"])}</p></div></li>')


def _report_part_row(part: dict) -> str:
    return (f'<tr><td>{html.escape(part["id"])}</td><td>{html.escape(part["name"])}</td><td>{part["volume"]:,.1f}</td>'
            f'<td>{" × ".join(f"{extent:.1f}" for extent in part["bbox"]["size"])}</td><td>{part["faces"]}</td>'
            f'<td>{"yes" if part["valid"] else "<b>no</b>"}</td></tr>')


def _report_issue_item(issue: dict) -> str:
    references = f'<code>{html.escape(", ".join(issue.get("refs", [])[:12]))}</code>' if issue.get("refs") else ""
    return (f'<li class="{html.escape(issue["severity"])}"><span class="label">{html.escape(issue["severity"])} · '
            f'{html.escape(issue["code"])}</span><p>{html.escape(issue["message"])}</p>{references}</li>')


def _report_parameter_rows(version: dict) -> str:
    params = version.get("params") or {}
    return "".join(f'<tr><td>{html.escape(parameter["name"])}</td>'
                   f'<td>{html.escape(str(params.get(parameter["name"], parameter["default"])))}</td>'
                   f'<td>{html.escape(str(parameter["default"]))}</td></tr>' for parameter in version.get("param_schema") or [])


def build_design_report_html(version_directory: str, version: dict, document: dict | None, manufacturability: dict) -> str:
    summary = version.get("summary") or {}
    escaped_name = html.escape((document or {}).get("name") or "Untitled model")
    view_images = {view_name: _png_data_uri(render.render_version_png(version_directory, view_name, 520, 400))
                   for view_name in REPORT_VIEW_NAMES}
    labelled_image = _png_data_uri(render.render_version_png(version_directory, "iso", 900, 640, labels=True))
    steps = version.get("steps") or []
    step_items = "".join(_report_step_item(version_directory, step) for step in steps)
    part_rows = "".join(_report_part_row(part) for part in summary.get("parts", []))
    parameter_rows = _report_parameter_rows(version)
    issue_items = ("".join(_report_issue_item(issue) for issue in manufacturability.get("issues", []))
                   or '<li><p>No manufacturability issues found for FDM printing.</p></li>')
    mass_rows = "".join(f'<tr><td>{material_label}</td><td>{summary.get("mass_g_" + material_key, 0):,.1f} g</td></tr>'
                        for material_label, material_key in REPORT_MASS_MATERIALS)
    bounding_box = summary.get("bbox", {"min": [0, 0, 0], "max": [0, 0, 0]})
    size = [highest - lowest for lowest, highest in zip(bounding_box["min"], bounding_box["max"])]
    escaped_version_id = html.escape(version["id"])
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escaped_name} — Design report</title>
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
<header class="wrap"><div class="wm">BISCAD</div><h1>{escaped_name}</h1>
<p class="label" style="margin-top:10px">Design report · version {escaped_version_id}</p>
<div class="stats">
<div class="stat"><b>{size[0]:.1f} × {size[1]:.1f} × {size[2]:.1f}</b><span class="label">Size mm</span></div>
<div class="stat"><b>{summary.get("volume", 0) / 1000:,.2f}</b><span class="label">Volume cm³</span></div>
<div class="stat"><b>{len(summary.get("parts", []))}</b><span class="label">Parts</span></div>
<div class="stat"><b>{len(steps)}</b><span class="label">Build steps</span></div>
</div></header>
<main class="wrap">
<section><span class="label">Views</span><h2>What was built</h2><div class="views">
{''.join(f'<figure><img src="{image_uri}" alt="{view_name} view"><figcaption>{view_name}</figcaption></figure>' for view_name, image_uri in view_images.items())}
</div></section>
<section><span class="label">References</span><h2>Face ids, as the API and agents see them</h2>
<img class="big" src="{labelled_image}" alt="labelled faces"></section>
<section><span class="label">Build steps</span><h2>How it was built</h2><ol class="steps">{step_items or '<li><div></div><p>This model was built without BuildPart steps (algebra mode).</p></li>'}</ol></section>
<section><span class="label">Parts</span><h2>Bill of materials</h2>
<table><tr><th>Id</th><th>Name</th><th>Volume mm³</th><th>Size mm</th><th>Faces</th><th>Valid</th></tr>{part_rows}</table></section>
<section><span class="label">Mass</span><h2>Mass by material</h2><table>{mass_rows}</table>
<p class="label" style="margin-top:16px">Centre of mass {html.escape(str(summary.get("center_of_mass")))}</p></section>
<section><span class="label">Manufacturability</span><h2>FDM check</h2><ul class="dfm">{issue_items}</ul></section>
{f'<section><span class="label">Parameters</span><h2>Configuration</h2><table><tr><th>Name</th><th>Value</th><th>Default</th></tr>{parameter_rows}</table></section>' if parameter_rows else ''}
<section><span class="label">Source</span><h2>Program</h2><pre>{html.escape(version.get("script") or "")}</pre></section>
</main><footer>Generated by BISCAD</footer></body></html>"""
