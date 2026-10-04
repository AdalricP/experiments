from __future__ import annotations

import contextlib
import itertools
import json
import math
import os

import build123d as bd
import numpy as np
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.BRepIntCurveSurface import BRepIntCurveSurface_Inter
from OCP.gp import gp_Dir, gp_Lin, gp_Pnt
from OCP.GProp import GProp_GProps

from kernel import is_shape_valid, load_parts_from_version_directory
from persistent_naming import index_reference_for, is_persistent_reference
from tessellate import describe_edge, describe_face

EXPORT_FORMATS = {
    "step": ("model.step", "application/step"),
    "stl": ("model.stl", "model/stl"),
    "glb": ("model.glb", "model/gltf-binary"),
    "3mf": ("model.3mf", "model/3mf"),
    "brep": ("model.brep", "application/octet-stream"),
    "svg": ("drawing.svg", "image/svg+xml"),
    "dxf": ("drawing.dxf", "image/vnd.dxf"),
    "obj": ("model.obj", "text/plain"),
}
BUILD_ENVELOPES_IN_MILLIMETERS = {"fdm": (256, 256, 256), "cnc": (600, 400, 300), "sheet": (1500, 3000, 50)}
MINIMUM_WALL_IN_MILLIMETERS_BY_PROCESS = {"fdm": 0.8, "cnc": 0.5, "sheet": 0.3}
EXPORT_LINEAR_DEFLECTION_IN_MILLIMETERS = 0.01
EXPORT_ANGULAR_DEFLECTION_IN_RADIANS = 0.2
TINY_EDGE_LENGTH_IN_MILLIMETERS = 0.2
OVERHANG_NORMAL_Z_LIMIT = -0.7072
BED_CLEARANCE_IN_MILLIMETERS = 0.3
SMALL_TOOL_RADIUS_IN_MILLIMETERS = 1.0
MAX_FACES_SAMPLED_FOR_WALL_THICKNESS = 400
DRAWING_VIEW_GAP_FRACTION = 0.35
EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'


def _compound_of_shapes(shapes: list, label: str | None = None):
    if len(shapes) == 1:
        return shapes[0]
    return bd.Compound(label=label, children=shapes) if label else bd.Compound(children=shapes)


def _try_apply_color(shape, color: str | None):
    if not color:
        return
    with contextlib.suppress(Exception):
        shape.color = bd.Color(color)


def _labelled_colored_compound(parts: list):
    for name, shape, color in parts:
        shape.label = name
        _try_apply_color(shape, color)
    return _compound_of_shapes([shape for _name, shape, _color in parts], label="model")


def _write_3mf(parts: list, temporary_path: str):
    mesher = bd.Mesher()
    for _name, shape, _color in parts:
        mesher.add_shape(shape, linear_deflection=EXPORT_LINEAR_DEFLECTION_IN_MILLIMETERS,
                         angular_deflection=EXPORT_ANGULAR_DEFLECTION_IN_RADIANS)
    mesher.write(temporary_path + ".3mf")
    os.replace(temporary_path + ".3mf", temporary_path)


def _write_export_file(format_name: str, version_directory: str, parts: list, compound, temporary_path: str):
    linear_deflection, angular_deflection = EXPORT_LINEAR_DEFLECTION_IN_MILLIMETERS, EXPORT_ANGULAR_DEFLECTION_IN_RADIANS
    writers = {
        "step": lambda: bd.export_step(compound, temporary_path),
        "stl": lambda: bd.export_stl(compound, temporary_path, tolerance=linear_deflection, angular_tolerance=angular_deflection),
        "glb": lambda: bd.export_gltf(compound, temporary_path, binary=True, linear_deflection=linear_deflection,
                                      angular_deflection=angular_deflection),
        "brep": lambda: bd.export_brep(compound, temporary_path),
        "3mf": lambda: _write_3mf(parts, temporary_path),
        "obj": lambda: _write_obj(version_directory, temporary_path),
    }
    writers.get(format_name, lambda: _write_three_view_drawing(compound, temporary_path, format_name))()


def export_version(version_directory: str, format_name: str) -> str:
    export_path = os.path.join(version_directory, EXPORT_FORMATS[format_name][0])
    if os.path.exists(export_path):
        return export_path
    parts = load_parts_from_version_directory(version_directory)
    compound = _labelled_colored_compound(parts)
    _write_export_file(format_name, version_directory, parts, compound, export_path + ".tmp")
    os.replace(export_path + ".tmp", export_path)
    return export_path


def _obj_lines_for_part(part_id: str, part_name: str, mesh_arrays, first_vertex_number: int) -> list[str]:
    positions, normals = mesh_arrays[f"{part_id}_pos"], mesh_arrays[f"{part_id}_nrm"]
    triangles = mesh_arrays[f"{part_id}_idx"].reshape(-1, 3) + first_vertex_number
    return ([f"o {part_name}\n"] + ["v %.5f %.5f %.5f\n" % tuple(position) for position in positions]
            + ["vn %.4f %.4f %.4f\n" % tuple(normal) for normal in normals]
            + ["f %d//%d %d//%d %d//%d\n" % (corners[0], corners[0], corners[1], corners[1], corners[2], corners[2])
               for corners in triangles])


def _write_obj(version_directory: str, path: str):
    mesh_arrays = np.load(os.path.join(version_directory, "mesh.npz"))
    with open(os.path.join(version_directory, "topology.json")) as topology_file:
        topology = json.load(topology_file)
    obj_lines, first_vertex_number = ["# BISCAD OBJ export\n"], 1
    for part in topology["parts"]:
        obj_lines += _obj_lines_for_part(part["id"], part["name"], mesh_arrays, first_vertex_number)
        first_vertex_number += len(mesh_arrays[f"{part['id']}_pos"])
    with open(path, "w") as obj_file:
        obj_file.writelines(obj_lines)


def _drawing_exporter(format_name: str):
    if format_name == "svg":
        exporter = bd.ExportSVG(unit=bd.Unit.MM, line_weight=0.35, margin=8)
        exporter.add_layer("visible", line_weight=0.35)
        exporter.add_layer("hidden", line_color=(140, 140, 140), line_type=bd.LineType.ISO_DASH, line_weight=0.2)
        return exporter
    exporter = bd.ExportDXF(unit=bd.Unit.MM)
    exporter.add_layer("visible")
    exporter.add_layer("hidden", line_type=bd.LineType.ISO_DASH)
    return exporter


def _add_projected_view(exporter, shape, view_name: str, view_setup: tuple, center, model_size: float):
    view_direction, view_up, (sheet_offset_x, sheet_offset_y) = view_setup
    eye_position = center + bd.Vector(*view_direction).normalized() * model_size * 4
    try:
        visible_edges, hidden_edges = shape.project_to_viewport(tuple(eye_position), viewport_up=view_up,
                                                                look_at=tuple(center))
    except Exception:
        return
    sheet_shift = bd.Location((sheet_offset_x, sheet_offset_y, 0))
    exporter.add_shape([edge.moved(sheet_shift) for edge in visible_edges], layer="visible")
    if view_name != "iso":
        exporter.add_shape([edge.moved(sheet_shift) for edge in hidden_edges], layer="hidden")


def _write_three_view_drawing(shape, path: str, format_name: str):
    bounding_box = shape.bounding_box()
    model_size = max(bounding_box.size.X, bounding_box.size.Y, bounding_box.size.Z, 1e-3)
    offset = model_size + model_size * DRAWING_VIEW_GAP_FRACTION
    views = {
        "front": ((0, -1, 0), (0, 0, 1), (0, 0)),
        "top": ((0, 0, 1), (0, 1, 0), (0, offset)),
        "right": ((1, 0, 0), (0, 0, 1), (offset, 0)),
        "iso": ((1, -1, 0.8), (0, 0, 1), (offset, offset)),
    }
    exporter = _drawing_exporter(format_name)
    for view_name, view_setup in views.items():
        _add_projected_view(exporter, shape, view_name, view_setup, bounding_box.center(), model_size)
    exporter.write(path)


def _resolve_reference(parts: list, reference: str):
    try:
        part_token, _separator, sub_entity = reference.partition("/")
        part_shape = parts[int(part_token.lstrip("p"))][1]
        if not sub_entity:
            return part_shape
        entity_lists = {"f": part_shape.faces, "e": part_shape.edges, "v": part_shape.vertices}
        return entity_lists[sub_entity[0]]()[int(sub_entity[1:])]
    except Exception:
        raise ValueError(f"unknown reference '{reference}' (expected like p0/f3, p0/#1a2b3c4d, p0/e7, p0/v1 or p0)")


def _rounded_point(point, decimal_places: int) -> list[float]:
    return [round(coordinate, decimal_places) for coordinate in (point.X(), point.Y(), point.Z())]


def _distance_measurements(first_entity, second_entity) -> dict:
    distance_solver = BRepExtrema_DistShapeShape(first_entity.wrapped, second_entity.wrapped)
    distance_solver.Perform()
    if not distance_solver.IsDone():
        return {}
    return {"distance": round(distance_solver.Value(), 6),
            "closest_points": [_rounded_point(distance_solver.PointOnShape1(1), 5),
                               _rounded_point(distance_solver.PointOnShape2(1), 5)]}


def _angle_measurements(first_entity, second_entity) -> dict:
    first_direction, second_direction = _principal_direction(first_entity), _principal_direction(second_entity)
    if first_direction is None or second_direction is None:
        return {}
    cosine = max(-1.0, min(1.0, first_direction.dot(second_direction)))
    return {"angle_deg": round(math.degrees(math.acos(abs(cosine))), 4), "parallel": abs(abs(cosine) - 1) < 1e-6,
            "perpendicular": abs(cosine) < 1e-6}


def _index_references_of_version(version_directory: str, references: list) -> list:
    if not any(is_persistent_reference(reference) for reference in references if reference):
        return references
    with open(os.path.join(version_directory, "topology.json")) as topology_file:
        topology = json.load(topology_file)
    return [index_reference_for(reference, topology) if reference else reference for reference in references]


def measure_references(version_directory: str, first_reference: str, second_reference: str | None = None) -> dict:
    parts = load_parts_from_version_directory(version_directory)
    first_reference, second_reference = _index_references_of_version(version_directory,
                                                                      [first_reference, second_reference])
    first_entity = _resolve_reference(parts, first_reference)
    measurements = {"a": _describe_entity(first_entity, first_reference)}
    if not second_reference:
        return measurements
    second_entity = _resolve_reference(parts, second_reference)
    measurements["b"] = _describe_entity(second_entity, second_reference)
    measurements |= _distance_measurements(first_entity, second_entity)
    with contextlib.suppress(Exception):
        measurements["center_distance"] = round((first_entity.center() - second_entity.center()).length, 6)
    return measurements | _angle_measurements(first_entity, second_entity)


def _principal_direction(entity):
    try:
        if isinstance(entity, bd.Face) and entity.geom_type == bd.GeomType.PLANE:
            return entity.normal_at(entity.center())
        if isinstance(entity, bd.Face) and entity.geom_type in (bd.GeomType.CYLINDER, bd.GeomType.CONE):
            return entity.axis_of_rotation.direction
        if isinstance(entity, bd.Edge) and entity.geom_type == bd.GeomType.LINE:
            return (entity.position_at(1) - entity.position_at(0)).normalized()
        if isinstance(entity, bd.Edge) and entity.geom_type == bd.GeomType.CIRCLE:
            return entity.normal()
    except Exception:
        return None
    return None


def _describe_entity(entity, reference: str) -> dict:
    if isinstance(entity, bd.Face):
        return describe_face(entity, reference)
    if isinstance(entity, bd.Edge):
        return describe_edge(entity, reference)
    if isinstance(entity, bd.Vertex):
        return {"id": reference, "type": "vertex", "position": [round(coordinate, 5) for coordinate in tuple(entity)]}
    bounding_box = entity.bounding_box()
    return {"id": reference, "type": "part", "volume": round(entity.volume, 4),
            "bbox": [[round(coordinate, 4) for coordinate in tuple(bounding_box.min)],
                     [round(coordinate, 4) for coordinate in tuple(bounding_box.max)]]}


def _is_face_on_plane(face, plane) -> bool:
    try:
        center = face.center()
        return (abs((center - plane.origin).dot(plane.z_dir)) < 1e-4
                and abs(face.normal_at(center).dot(plane.z_dir)) > 0.999)
    except Exception:
        return False


def _cut_faces_on_plane(shape, kept_half_space, plane) -> list:
    try:
        kept_material = shape & kept_half_space
    except Exception:
        return []
    return [face for face in (kept_material.faces() if kept_material else []) if _is_face_on_plane(face, plane)]


def section_with_plane(version_directory: str, origin, normal) -> dict:
    plane = bd.Plane(origin=tuple(origin), z_dir=tuple(normal))
    huge_size = 1e5
    kept_half_space = bd.Box(huge_size, huge_size, huge_size, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MAX)
                             ).moved(bd.Location(plane))
    cut_faces = [face for _name, shape, _color in load_parts_from_version_directory(version_directory)
                 for face in _cut_faces_on_plane(shape, kept_half_space, plane)]
    return {"area": round(sum(face.area for face in cut_faces), 4), "regions": len(cut_faces),
            "svg": _hatched_section_svg(cut_faces, plane)}


def _sampled_wire_points(wire) -> list:
    points = []
    for edge in wire.edges():
        sample_count = 2 if edge.geom_type == bd.GeomType.LINE else 24
        points += [edge.position_at(sample_index / sample_count) for sample_index in range(sample_count)]
    return points


def _svg_path_data_for_face(face) -> str:
    path_data = ""
    for wire in [face.outer_wire()] + list(face.inner_wires()):
        points = _sampled_wire_points(wire)
        if points:
            path_data += "M" + " L".join(f"{point.X:.3f},{-point.Y:.3f}" for point in points) + " Z "
    return path_data


def _hatched_section_svg(faces: list, plane) -> str:
    if not faces:
        return EMPTY_SVG
    local_faces = [plane.to_local_coords(face) for face in faces]
    bounding_box = bd.Compound(children=local_faces).bounding_box()
    padding = max(bounding_box.size.X, bounding_box.size.Y) * 0.06 + 1
    left, bottom = bounding_box.min.X - padding, bounding_box.min.Y - padding
    width, height = bounding_box.size.X + 2 * padding, bounding_box.size.Y + 2 * padding
    body = "".join(f'<path d="{_svg_path_data_for_face(face)}" fill="url(#hatch)" stroke="#121212" '
                   f'stroke-width="{width / 400:.3f}" fill-rule="evenodd"/>' for face in local_faces)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left:.3f} {-(bottom + height):.3f} {width:.3f} {height:.3f}">'
            f'<defs><pattern id="hatch" width="{width / 60:.3f}" height="{width / 60:.3f}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
            f'<line x1="0" y1="0" x2="0" y2="{width / 60:.3f}" stroke="#121212" stroke-width="{width / 600:.3f}"/></pattern></defs>{body}</svg>')


def _mass_properties_of_part(part_index: int, name: str, shape, density_in_grams_per_cubic_centimeter: float):
    volume_properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape.wrapped, volume_properties)
    volume_in_cubic_millimeters = volume_properties.Mass()
    mass_in_grams = volume_in_cubic_millimeters / 1000.0 * density_in_grams_per_cubic_centimeter
    center_point = volume_properties.CentreOfMass()
    center = (center_point.X(), center_point.Y(), center_point.Z())
    inertia_matrix = volume_properties.MatrixOfInertia()
    inertia = [[round(inertia_matrix.Value(row, column) * density_in_grams_per_cubic_centimeter / 1e6, 6)
                for column in (1, 2, 3)] for row in (1, 2, 3)]
    return {"id": f"p{part_index}", "name": name, "volume_mm3": round(volume_in_cubic_millimeters, 4),
            "mass_g": round(mass_in_grams, 4), "center_of_mass": [round(coordinate, 4) for coordinate in center],
            "inertia_kg_mm2_about_com": inertia, "surface_area_mm2": round(shape.area, 4)}, mass_in_grams, center


def mass_properties(version_directory: str, density_in_grams_per_cubic_centimeter: float = 7.85) -> dict:
    measured = [_mass_properties_of_part(part_index, name, shape, density_in_grams_per_cubic_centimeter)
                for part_index, (name, shape, _color) in enumerate(load_parts_from_version_directory(version_directory))]
    total_mass_in_grams = sum((mass for _summary, mass, _center in measured), 0.0)
    mass_moments = [sum((center[axis] * mass for _summary, mass, center in measured), 0.0) for axis in range(3)]
    center_of_mass = [round(moment / total_mass_in_grams, 4) for moment in mass_moments] if total_mass_in_grams else None
    return {"density_g_cm3": density_in_grams_per_cubic_centimeter, "parts": [summary for summary, _mass, _center in measured],
            "mass_g": round(total_mass_in_grams, 4), "center_of_mass": center_of_mass}


def _envelope_issue(part_id: str, name: str, bounding_box, process: str) -> dict | None:
    part_size = sorted([bounding_box.size.X, bounding_box.size.Y, bounding_box.size.Z])
    envelope = sorted(BUILD_ENVELOPES_IN_MILLIMETERS.get(process, BUILD_ENVELOPES_IN_MILLIMETERS["fdm"]))
    if not any(part_extent > envelope_extent for part_extent, envelope_extent in zip(part_size, envelope)):
        return None
    return {"severity": "error", "part": part_id, "code": "too_large",
            "message": f"{name} ({' × '.join(f'{extent:.0f}' for extent in part_size)} mm) does not fit a typical "
                       f"{process} envelope {' × '.join(map(str, envelope))} mm."}


def _solid_issues(part_id: str, name: str, shape) -> list[dict]:
    issues = []
    if not is_shape_valid(shape):
        issues.append({"severity": "error", "part": part_id, "code": "invalid", "message": f"{name} is not a valid solid."})
    if len(shape.solids()) > 1:
        issues.append({"severity": "warning", "part": part_id, "code": "multiple_solids",
                       "message": f"{name} has {len(shape.solids())} disconnected solids."})
    short_edge_indices = [edge_index for edge_index, edge in enumerate(shape.edges())
                          if edge.length < TINY_EDGE_LENGTH_IN_MILLIMETERS]
    if short_edge_indices:
        issues.append({"severity": "warning", "part": part_id, "code": "tiny_edges",
                       "message": f"{len(short_edge_indices)} edges shorter than 0.2 mm (may not be manufacturable).",
                       "refs": [f"{part_id}/e{edge_index}" for edge_index in short_edge_indices[:20]]})
    return issues


def _area_and_overhang_of_face(face, lowest_z: float) -> tuple[float, bool]:
    try:
        area = face.area
    except Exception:
        return 0.0, False
    try:
        normal = face.normal_at(face.center())
        return area, normal.Z < OVERHANG_NORMAL_Z_LIMIT and face.center().Z > lowest_z + BED_CLEARANCE_IN_MILLIMETERS
    except Exception:
        return area, False


def _overhang_issues_and_metrics(part_id: str, shape, lowest_z: float) -> tuple[list[dict], dict]:
    measured_faces = [_area_and_overhang_of_face(face, lowest_z) for face in shape.faces()]
    overhanging_face_ids = [f"{part_id}/f{face_index}"
                            for face_index, (_area, is_overhanging) in enumerate(measured_faces) if is_overhanging]
    overhang_area = sum((area for area, is_overhanging in measured_faces if is_overhanging), 0.0)
    total_area = sum((area for area, _is_overhanging in measured_faces), 0.0)
    metrics = {"overhang_area_mm2": round(overhang_area, 2),
               "overhang_fraction": round(overhang_area / total_area, 4) if total_area else 0}
    if not overhanging_face_ids:
        return [], metrics
    return [{"severity": "info", "part": part_id, "code": "overhangs",
             "message": f"{len(overhanging_face_ids)} faces overhang more than 45° and need support in this orientation.",
             "refs": overhanging_face_ids[:40]}], metrics


def _is_small_radius_cylinder(face) -> bool:
    try:
        return face.geom_type == bd.GeomType.CYLINDER and face.radius < SMALL_TOOL_RADIUS_IN_MILLIMETERS
    except Exception:
        return False


def _small_radius_issues(part_id: str, shape) -> list[dict]:
    small_radius_face_ids = [f"{part_id}/f{face_index}" for face_index, face in enumerate(shape.faces())
                             if _is_small_radius_cylinder(face)]
    if not small_radius_face_ids:
        return []
    return [{"severity": "warning", "part": part_id, "code": "small_radius",
             "message": f"{len(small_radius_face_ids)} cylindrical faces under 1 mm radius need small tools.",
             "refs": small_radius_face_ids[:40]}]


def _inspect_part_for_process(part_id: str, name: str, shape, process: str) -> tuple[list[dict], dict]:
    bounding_box = shape.bounding_box()
    envelope_issue = _envelope_issue(part_id, name, bounding_box, process)
    issues = ([envelope_issue] if envelope_issue else []) + _solid_issues(part_id, name, shape)
    metrics = {}
    if process == "fdm":
        overhang_issues, metrics = _overhang_issues_and_metrics(part_id, shape, bounding_box.min.Z)
        issues += overhang_issues
    if process == "cnc":
        issues += _small_radius_issues(part_id, shape)
    try:
        minimum_wall = _estimate_minimum_wall_thickness(shape)
    except Exception:
        return issues, metrics
    metrics = metrics | {"min_wall_mm_estimate": minimum_wall}
    wall_limit = MINIMUM_WALL_IN_MILLIMETERS_BY_PROCESS.get(process, 0.8)
    if minimum_wall is not None and minimum_wall < wall_limit:
        issues.append({"severity": "warning", "part": part_id, "code": "thin_wall",
                       "message": f"Estimated minimum wall {minimum_wall:.2f} mm is under {wall_limit} mm for {process}."})
    return issues, metrics


def check_manufacturability(version_directory: str, process: str = "fdm") -> dict:
    issues, metrics_by_part = [], {}
    for part_index, (name, shape, _color) in enumerate(load_parts_from_version_directory(version_directory)):
        part_issues, part_metrics = _inspect_part_for_process(f"p{part_index}", name, shape, process)
        issues += part_issues
        if part_metrics:
            metrics_by_part[f"p{part_index}"] = part_metrics
    return {"process": process, "ok": not any(issue["severity"] == "error" for issue in issues),
            "issues": issues, "metrics": metrics_by_part}


def _first_hit_beyond(intersector, minimum_distance: float) -> float | None:
    while intersector.More():
        hit_distance = intersector.W()
        if hit_distance > minimum_distance:
            return hit_distance
        intersector.Next()
    return None


def _inward_ray_exit_distance(shape, face) -> float | None:
    try:
        center = face.center()
        normal = face.normal_at(center)
        ray_start = center - normal * 1e-3
        intersector = BRepIntCurveSurface_Inter()
        intersector.Init(shape.wrapped, gp_Lin(gp_Pnt(ray_start.X, ray_start.Y, ray_start.Z),
                                               gp_Dir(-normal.X, -normal.Y, -normal.Z)), 1e-6)
        return _first_hit_beyond(intersector, 1e-3)
    except Exception:
        return None


def _estimate_minimum_wall_thickness(shape) -> float | None:
    sampled_faces = shape.faces()[:MAX_FACES_SAMPLED_FOR_WALL_THICKNESS]
    exit_distances = [distance for distance in (_inward_ray_exit_distance(shape, face) for face in sampled_faces)
                      if distance is not None]
    return round(min(exit_distances), 4) if exit_distances else None


def _face_signatures(shape) -> set:
    return {(face.geom_type.name, round(face.area, 3), tuple(round(coordinate, 3) for coordinate in tuple(face.center())))
            for face in shape.faces()}


def _boolean_volume_changes(first_shape, second_shape) -> dict:
    changes = {}
    try:
        added_material, removed_material = second_shape - first_shape, first_shape - second_shape
        changes["volume_added"] = round(added_material.volume, 4) if added_material else 0.0
        changes["volume_removed"] = round(removed_material.volume, 4) if removed_material else 0.0
    except Exception as boolean_error:
        changes["boolean_error"] = str(boolean_error)
    return changes


def diff_versions(first_version_directory: str, second_version_directory: str) -> dict:
    first_shape, second_shape = (
        _compound_of_shapes([shape for _name, shape, _color in load_parts_from_version_directory(directory)])
        for directory in (first_version_directory, second_version_directory))
    comparison = {"volume_a": round(first_shape.volume, 4), "volume_b": round(second_shape.volume, 4)}
    comparison |= _boolean_volume_changes(first_shape, second_shape)
    first_faces, second_faces = _face_signatures(first_shape), _face_signatures(second_shape)
    comparison["faces_a"], comparison["faces_b"] = len(first_faces), len(second_faces)
    comparison["faces_added"] = len(second_faces - first_faces)
    comparison["faces_removed"] = len(first_faces - second_faces)
    comparison["bbox_change"] = [round(second_extent - first_extent, 4) for first_extent, second_extent
                                 in zip(tuple(first_shape.bounding_box().size), tuple(second_shape.bounding_box().size))]
    comparison["identical"] = (comparison["faces_added"] == 0 and comparison["faces_removed"] == 0
                               and abs(comparison["volume_a"] - comparison["volume_b"]) < 1e-6)
    return comparison


def _bounding_boxes_overlap(first_box, second_box) -> bool:
    return not (first_box.min.X > second_box.max.X or second_box.min.X > first_box.max.X
                or first_box.min.Y > second_box.max.Y or second_box.min.Y > first_box.max.Y
                or first_box.min.Z > second_box.max.Z or second_box.min.Z > first_box.max.Z)


def _clash_between(parts: list, first_index: int, second_index: int, tolerance_in_cubic_millimeters: float):
    try:
        common_material = parts[first_index][1] & parts[second_index][1]
        overlap_volume = common_material.volume if common_material is not None else 0.0
    except Exception:
        return None
    if overlap_volume <= tolerance_in_cubic_millimeters:
        return None
    return {"a": f"p{first_index}", "b": f"p{second_index}", "a_name": parts[first_index][0],
            "b_name": parts[second_index][0], "volume_mm3": round(overlap_volume, 4),
            "center": [round(coordinate, 3) for coordinate in tuple(common_material.center())]}


def detect_interference(version_directory: str, tolerance_in_cubic_millimeters: float = 1e-3) -> dict:
    parts = load_parts_from_version_directory(version_directory)
    bounding_boxes = [shape.bounding_box() for _name, shape, _color in parts]
    overlapping_pairs = [(first_index, second_index)
                         for first_index, second_index in itertools.combinations(range(len(parts)), 2)
                         if _bounding_boxes_overlap(bounding_boxes[first_index], bounding_boxes[second_index])]
    clashes = [clash for clash in (_clash_between(parts, first_index, second_index, tolerance_in_cubic_millimeters)
                                   for first_index, second_index in overlapping_pairs) if clash]
    clashes.sort(key=lambda clash: -clash["volume_mm3"])
    return {"parts": len(parts), "pairs_checked": len(overlapping_pairs), "clashes": clashes, "ok": not clashes}


def bill_of_materials(version_directory: str, density_in_grams_per_cubic_centimeter: float | None = None) -> dict:
    parts = load_parts_from_version_directory(version_directory)
    groups_by_identity: dict = {}
    for part_index, (name, shape, _color) in enumerate(parts):
        part_size = [round(extent, 2) for extent in tuple(shape.bounding_box().size)]
        identity = (round(shape.volume, 2), round(shape.area, 2), len(shape.faces()), tuple(sorted(part_size)))
        group = groups_by_identity.setdefault(identity, {
            "name": name, "quantity": 0, "ids": [], "volume_mm3": round(shape.volume, 3),
            "size_mm": part_size, "faces": len(shape.faces())})
        group["quantity"] += 1
        group["ids"].append(f"p{part_index}")
        if density_in_grams_per_cubic_centimeter:
            group["mass_g_each"] = round(shape.volume / 1000 * density_in_grams_per_cubic_centimeter, 3)
    bom_lines = sorted(groups_by_identity.values(), key=lambda group: (-group["quantity"], group["name"]))
    numbered_lines = [bom_line | {"item": line_number} for line_number, bom_line in enumerate(bom_lines, 1)]
    return {"items": numbered_lines, "unique_parts": len(numbered_lines), "total_parts": len(parts)}
