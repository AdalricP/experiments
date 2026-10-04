from __future__ import annotations

import io
import json
import math
import os
from typing import NamedTuple

import numpy as np
from PIL import Image, ImageDraw, ImageFont

VIEW_DIRECTIONS = {
    "iso": (1.0, -1.0, 0.8), "iso2": (-1.0, -1.0, 0.8), "iso_back": (-1.0, 1.0, 0.8),
    "iso_below": (1.0, -1.0, -0.8),
    "front": (0, -1, 0), "back": (0, 1, 0), "right": (1, 0, 0), "left": (-1, 0, 0),
    "top": (0, 0, 1), "bottom": (0, 0, -1),
}
GRID_VIEW_NAMES = ("iso", "front", "top", "right")
HIGHLIGHT_COLOR_RGB = np.array([255, 120, 40], float)
DEFAULT_PART_COLOR = "#d9d7d2"
SUPERSAMPLING_FACTOR = 2
MODEL_FILL_FRACTION_OF_CANVAS = 0.84
EDGE_COLOR_RGB = (28, 28, 28)
MONOSPACE_FONT_PATHS = ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
                        "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf")
AXIS_TRIAD = ((np.array([1, 0, 0.]), (200, 60, 50), "X"), (np.array([0, 1, 0.]), (60, 150, 70), "Y"),
              (np.array([0, 0, 1.]), (50, 90, 200), "Z"))


class ViewProjection(NamedTuple):
    view_direction: np.ndarray
    right_axis: np.ndarray
    up_axis: np.ndarray
    center: np.ndarray
    scale: float
    horizontal_center: float
    vertical_center: float
    canvas_width: int
    canvas_height: int


def _rgb_from_hex_color(hex_color: str | None) -> np.ndarray:
    hex_digits = (hex_color or DEFAULT_PART_COLOR).lstrip("#")
    return np.array([int(hex_digits[offset:offset + 2], 16) for offset in (0, 2, 4)], float)


def _normalized(vector: np.ndarray) -> np.ndarray:
    return vector / np.linalg.norm(vector)


def _camera_axes(view, bounding_box: dict):
    view_vector = view if isinstance(view, (list, tuple)) else VIEW_DIRECTIONS.get(view, VIEW_DIRECTIONS["iso"])
    view_direction = _normalized(np.array(view_vector, float))
    world_up = np.array([0, 0, 1.0]) if abs(view_direction[2]) < 0.99 else np.array([0, 1.0, 0])
    right_axis = _normalized(np.cross(world_up, view_direction))
    center = (np.array(bounding_box["min"]) + np.array(bounding_box["max"])) / 2
    return view_direction, right_axis, np.cross(view_direction, right_axis), center


def load_monospace_font(size_in_points: int):
    for font_path in MONOSPACE_FONT_PATHS:
        if os.path.exists(font_path):
            return ImageFont.truetype(font_path, size_in_points)
    try:
        return ImageFont.load_default(size_in_points)
    except TypeError:
        return ImageFont.load_default()


def _project(projection: ViewProjection, points: np.ndarray) -> np.ndarray:
    relative = points - projection.center
    return np.stack([(relative @ projection.right_axis - projection.horizontal_center) * projection.scale
                     + projection.canvas_width / 2,
                     projection.canvas_height / 2 - (relative @ projection.up_axis - projection.vertical_center) * projection.scale,
                     relative @ projection.view_direction], -1)


def _load_json(path: str):
    with open(path) as json_file:
        return json.load(json_file)


def _fit_projection(view, framing_directory: str, hidden_part_ids: set, canvas_width: int, canvas_height: int):
    framing_topology = _load_json(os.path.join(framing_directory, "topology.json"))
    framing_mesh = np.load(os.path.join(framing_directory, "mesh.npz"))
    view_direction, right_axis, up_axis, center = _camera_axes(view, framing_topology["bbox"])
    candidate_positions = [framing_mesh[f"{part['id']}_pos"] for part in framing_topology["parts"]
                           if part["id"] not in hidden_part_ids]
    visible_positions = [positions for positions in candidate_positions if len(positions)]
    if not visible_positions:
        return None, 0.0
    relative = np.concatenate(visible_positions) - center
    horizontal, vertical = relative @ right_axis, relative @ up_axis
    horizontal_span, vertical_span = horizontal.max() - horizontal.min(), vertical.max() - vertical.min()
    scale = MODEL_FILL_FRACTION_OF_CANVAS * min(canvas_width / max(horizontal_span, 1e-6),
                                                canvas_height / max(vertical_span, 1e-6))
    projection = ViewProjection(view_direction, right_axis, up_axis, center, scale,
                                (horizontal.max() + horizontal.min()) / 2, (vertical.max() + vertical.min()) / 2,
                                canvas_width, canvas_height)
    return projection, max(horizontal_span, vertical_span, 1e-6)


def _shaded_triangles_of_part(part: dict, mesh, base_color: np.ndarray, highlighted_ids: set, projection: ViewProjection):
    positions, normals = mesh[f"{part['id']}_pos"], mesh[f"{part['id']}_nrm"]
    triangle_indices = mesh[f"{part['id']}_idx"].reshape(-1, 3)
    if not len(triangle_indices):
        return None
    triangle_colors = np.tile(base_color, (len(triangle_indices), 1))
    for face in part["faces"]:
        if part["id"] in highlighted_ids or face["id"] in highlighted_ids:
            triangle_colors[face["start"]:face["start"] + face["count"]] = HIGHLIGHT_COLOR_RGB
    projected_triangles = _project(projection, positions)[triangle_indices]
    view_direction = projection.view_direction
    triangle_normals = normals[triangle_indices].mean(1)
    triangle_normals /= np.maximum(np.linalg.norm(triangle_normals, axis=1, keepdims=True), 1e-9)
    triangle_normals = np.where((triangle_normals @ view_direction)[:, None] < 0, -triangle_normals, triangle_normals)
    key_light = _normalized(np.array([0.45, -0.35, 0.82]))
    fill_light = _normalized(-view_direction * 0.6 + np.array([-0.5, 0.3, 0.2]))
    shade = (0.42 + 0.48 * np.clip(triangle_normals @ key_light, 0, 1)
             + 0.18 * np.clip(triangle_normals @ fill_light, 0, 1))
    specular = np.clip(triangle_normals @ ((key_light + view_direction) / np.linalg.norm(key_light + view_direction)),
                       0, 1) ** 40 * 0.25
    shaded_colors = np.clip(triangle_colors * shade[:, None] + 255 * specular[:, None], 0, 255)
    return projected_triangles[:, :, 2].mean(1), projected_triangles, shaded_colors


def _paint_triangles_back_to_front(image, depth_image, shaded_parts: list):
    color_raster, depth_raster = ImageDraw.Draw(image).draw, ImageDraw.Draw(depth_image).draw
    projected_triangles = np.concatenate([shaded[1] for shaded in shaded_parts])
    triangle_depths = np.concatenate([shaded[0] for shaded in shaded_parts])
    colors = np.concatenate([shaded[2] for shaded in shaded_parts]).astype(int)
    painting_order = np.argsort(triangle_depths)
    flat_polygons = projected_triangles[painting_order, :, :2].reshape(-1, 6).tolist()
    ordered_colors = [tuple(color) for color in colors[painting_order].tolist()]
    for flat_polygon, color, triangle_depth in zip(flat_polygons, ordered_colors, triangle_depths[painting_order].tolist()):
        color_raster.draw_polygon(flat_polygon, color_raster.draw_ink(color), 1)
        depth_raster.draw_polygon(flat_polygon, depth_raster.draw_ink(triangle_depth), 1)


def _sample_points_along_segments(segment_starts: np.ndarray, segment_ends: np.ndarray, sample_count: int) -> np.ndarray:
    interpolation_fractions = np.linspace(0, 1, sample_count + 1)
    return segment_starts[:, None] + (segment_ends - segment_starts)[:, None] * interpolation_fractions[None, :, None]


def _visible_runs_of_samples(samples: np.ndarray, is_visible: np.ndarray) -> list:
    visible_runs, current_run = [], []
    for sample_index in range(len(samples) - 1):
        if is_visible[sample_index] and is_visible[sample_index + 1]:
            current_run = current_run or [samples[sample_index]]
            current_run.append(samples[sample_index + 1])
            continue
        if current_run:
            visible_runs.append(current_run)
        current_run = []
    return visible_runs + [current_run] if current_run else visible_runs


def _visible_polylines_of_segments(projected_segments: np.ndarray, depth_buffer, depth_tolerance: float) -> list:
    canvas_height, canvas_width = depth_buffer.shape
    segment_starts, segment_ends = projected_segments[:, 0], projected_segments[:, 1]
    screen_offsets = (segment_ends[:, :2] - segment_starts[:, :2]).tolist()
    sample_counts = np.array([max(int(math.hypot(offset_x, offset_y) / 3), 1) for offset_x, offset_y in screen_offsets])
    polylines_by_segment_index = {}
    for sample_count in np.unique(sample_counts).tolist():
        segment_indices = np.flatnonzero(sample_counts == sample_count)
        samples = _sample_points_along_segments(segment_starts[segment_indices], segment_ends[segment_indices], sample_count)
        pixel_columns = np.clip(samples[:, :, 0].astype(int), 0, canvas_width - 1)
        pixel_rows = np.clip(samples[:, :, 1].astype(int), 0, canvas_height - 1)
        is_visible = samples[:, :, 2] >= depth_buffer[pixel_rows, pixel_columns] - depth_tolerance
        for segment_index, segment_samples, segment_visibility in zip(
                segment_indices.tolist(), samples[:, :, :2].tolist(), is_visible.tolist()):
            polylines_by_segment_index[segment_index] = _visible_runs_of_samples(segment_samples, segment_visibility)
    return [polyline for segment_index in sorted(polylines_by_segment_index)
            for polyline in polylines_by_segment_index[segment_index]]


def _draw_visible_edges(image, visible_parts: list, mesh, projection: ViewProjection, depth_buffer, model_span: float):
    raster = ImageDraw.Draw(image).draw
    edge_ink = raster.draw_ink(EDGE_COLOR_RGB)
    for part in visible_parts:
        edge_segments = mesh[f"{part['id']}_edges"]
        if not len(edge_segments):
            continue
        projected_segments = _project(projection, edge_segments.astype(float)).reshape(-1, 2, 3)
        for polyline in _visible_polylines_of_segments(projected_segments, depth_buffer, 0.012 * model_span):
            raster.draw_lines(polyline, edge_ink, SUPERSAMPLING_FACTOR + 1)


def _should_label_face(face: dict, should_label_all: bool, highlighted_ids: set, model_span: float) -> bool:
    if "center" not in face or (not should_label_all and face["id"] not in highlighted_ids):
        return False
    return not (should_label_all and face["area"] < 0.002 * (model_span ** 2) and face["id"] not in highlighted_ids)


def _draw_face_label(draw, font, label_text: str, label_x: float, label_y: float):
    text_box = draw.textbbox((label_x, label_y), label_text, font=font, anchor="mm")
    draw.rectangle((text_box[0] - 3, text_box[1] - 2, text_box[2] + 3, text_box[3] + 2), fill=(255, 255, 255),
                   outline=(30, 30, 30))
    draw.text((label_x, label_y), label_text, fill=(20, 20, 20), font=font, anchor="mm")


def _draw_face_labels(image, all_parts: list, visible_parts: list, projection: ViewProjection, depth_buffer,
                      model_span: float, should_label_all: bool, highlighted_ids: set):
    draw, font = ImageDraw.Draw(image), load_monospace_font(11)
    labelled_faces = [face for part in visible_parts for face in part["faces"]
                      if _should_label_face(face, should_label_all, highlighted_ids, model_span)]
    for face in labelled_faces:
        projected = _project(projection, np.array(face["center"], float))
        pixel_x, pixel_y = int(projected[0]), int(projected[1])
        is_on_canvas = 0 <= pixel_x < projection.canvas_width and 0 <= pixel_y < projection.canvas_height
        if not is_on_canvas or projected[2] < depth_buffer[pixel_y, pixel_x] - 0.02 * model_span:
            continue
        label_text = face["id"].split("/")[1] if len(all_parts) == 1 else face["id"]
        _draw_face_label(draw, font, label_text, projected[0] / SUPERSAMPLING_FACTOR, projected[1] / SUPERSAMPLING_FACTOR)


def _draw_axis_triad(image, right_axis: np.ndarray, up_axis: np.ndarray):
    draw, font = ImageDraw.Draw(image), load_monospace_font(10)
    origin = np.array([34.0, image.height - 34.0])
    for axis, color, axis_name in AXIS_TRIAD:
        axis_on_screen = np.array([axis @ right_axis, -(axis @ up_axis)]) * 20
        draw.line([tuple(origin), tuple(origin + axis_on_screen)], fill=color, width=2)
        draw.text(tuple(origin + axis_on_screen * 1.35), axis_name, fill=color, font=font, anchor="mm")


def render_version_image(version_directory: str, view="iso", width_in_pixels=800, height_in_pixels=600, highlight=(),
                         labels=False, edges=True, hidden=None, background="#ffffff", framing_directory=None):
    topology = _load_json(os.path.join(version_directory, "topology.json"))
    mesh = np.load(os.path.join(version_directory, "mesh.npz"))
    part_colors = _load_json(os.path.join(version_directory, "parts.json"))
    hidden_part_ids, highlighted_ids = set(hidden or ()), set(highlight or ())
    canvas_width, canvas_height = width_in_pixels * SUPERSAMPLING_FACTOR, height_in_pixels * SUPERSAMPLING_FACTOR
    projection, model_span = _fit_projection(view, framing_directory or version_directory, hidden_part_ids,
                                             canvas_width, canvas_height)
    if projection is None:
        return Image.new("RGB", (width_in_pixels, height_in_pixels), background)
    visible_parts = [part for part in topology["parts"] if part["id"] not in hidden_part_ids]
    shaded_parts = [_shaded_triangles_of_part(part, mesh, _rgb_from_hex_color(
        part_colors[part_index].get("color") if part_index < len(part_colors) else None), highlighted_ids, projection)
        for part_index, part in enumerate(topology["parts"]) if part["id"] not in hidden_part_ids]
    image = Image.new("RGB", (canvas_width, canvas_height), background)
    depth_image = Image.new("F", (canvas_width, canvas_height), -1e9)
    _paint_triangles_back_to_front(image, depth_image, [shaded for shaded in shaded_parts if shaded is not None])
    depth_buffer = np.asarray(depth_image)
    if edges:
        _draw_visible_edges(image, visible_parts, mesh, projection, depth_buffer, model_span)
    image = image.resize((width_in_pixels, height_in_pixels), Image.LANCZOS)
    if labels or highlighted_ids:
        _draw_face_labels(image, topology["parts"], visible_parts, projection, depth_buffer, model_span, labels,
                          highlighted_ids)
    _draw_axis_triad(image, projection.right_axis, projection.up_axis)
    return image


def png_bytes_of_image(image) -> bytes:
    png_buffer = io.BytesIO()
    image.save(png_buffer, "PNG", optimize=True)
    return png_buffer.getvalue()


def render_version_png(version_directory: str, view="iso", width_in_pixels=800, height_in_pixels=600, **render_options) -> bytes:
    return png_bytes_of_image(render_version_image(version_directory, view, width_in_pixels, height_in_pixels, **render_options))


def render_four_view_grid_png(version_directory: str, tile_size_in_pixels=420, labels=False) -> bytes:
    grid_image = Image.new("RGB", (tile_size_in_pixels * 2, tile_size_in_pixels * 2), "#ffffff")
    draw, font = ImageDraw.Draw(grid_image), load_monospace_font(12)
    for tile_index, view_name in enumerate(GRID_VIEW_NAMES):
        tile = render_version_image(version_directory, view_name, tile_size_in_pixels, tile_size_in_pixels, labels=labels)
        tile_x, tile_y = (tile_index % 2) * tile_size_in_pixels, (tile_index // 2) * tile_size_in_pixels
        grid_image.paste(tile, (tile_x, tile_y))
        draw.text((tile_x + 10, tile_y + 8), view_name.upper(), fill=(90, 90, 90), font=font)
    draw.line([(tile_size_in_pixels, 0), (tile_size_in_pixels, 2 * tile_size_in_pixels)], fill=(220, 220, 220))
    draw.line([(0, tile_size_in_pixels), (2 * tile_size_in_pixels, tile_size_in_pixels)], fill=(220, 220, 220))
    return png_bytes_of_image(grid_image)
