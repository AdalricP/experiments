from __future__ import annotations

import base64
import math

import numpy as np
from build123d import Compound, Shape, Vector
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepGProp import BRepGProp
from OCP.BRepLib import BRepLib_ToolTriangulatedShape
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_TrsfForm

from persistent_naming import persistent_face_ids

PART_COLOR_PALETTE = ["#d9d7d2", "#4a4a4a", "#b9c3c9", "#cdbfa8", "#9aa79a", "#c9b2b2", "#a7a2b8", "#8f8f8f"]
REVOLVED_SURFACE_TYPES = ("cylinder", "cone", "sphere", "torus")
MESH_QUALITY_PRESETS = {"draft": (600.0, 0.5), "normal": (2000.0, 0.25), "fine": (6000.0, 0.12)}
EDGE_ANGULAR_DEFLECTION_IN_RADIANS = 0.2
FALLBACK_EDGE_SAMPLE_COUNT = 24
TRANSFORMATION_FORMS_THAT_KEEP_DIRECTIONS = (gp_TrsfForm.gp_Identity, gp_TrsfForm.gp_Translation)
_current_mesh_quality = "normal"


def base64_of_array_bytes(array: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode("ascii")


def _rounded_floats(values, decimal_places=4) -> list[float]:
    return [round(float(component), decimal_places) for component in values]


def geometry_type_name(shape) -> str:
    try:
        return shape.geom_type.name.lower()
    except Exception:
        return "other"


def _properties_until_first_failure(property_getters: dict) -> dict:
    properties = {}
    for property_name, compute_property in property_getters.items():
        try:
            properties[property_name] = compute_property()
        except Exception:
            break
    return properties


def _surface_properties_of_face(face) -> GProp_GProps:
    surface_properties = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face.wrapped, surface_properties)
    return surface_properties


def _center_of_face(face, surface_properties: GProp_GProps) -> Vector:
    return Vector(surface_properties.CentreOfMass()) if face.is_planar else face.center()


def describe_face(face, face_id: str) -> dict:
    surface_properties = _surface_properties_of_face(face)
    description = {"id": face_id, "type": geometry_type_name(face), "area": round(surface_properties.Mass(), 4)}
    try:
        center = _center_of_face(face, surface_properties)
    except Exception:
        return description
    description["center"] = _rounded_floats(center)
    if description["type"] == "plane":
        return description | _properties_until_first_failure({"normal": lambda: _rounded_floats(face.normal_at(center))})
    if description["type"] not in REVOLVED_SURFACE_TYPES:
        return description
    return (description | _properties_until_first_failure({"radius": lambda: round(face.radius, 4)})
            | _properties_until_first_failure({"axis": lambda: _rounded_floats(face.axis_of_rotation.direction)}))


def describe_edge(edge, edge_id: str) -> dict:
    description = {"id": edge_id, "type": geometry_type_name(edge), "length": round(edge.length, 4)}
    property_getters = {"start": lambda: _rounded_floats(edge.position_at(0)),
                        "end": lambda: _rounded_floats(edge.position_at(1))}
    if description["type"] == "circle":
        property_getters |= {"radius": lambda: round(edge.radius, 4), "center": lambda: _rounded_floats(edge.arc_center)}
    return description | _properties_until_first_failure(property_getters)


def _vertex_normals_from_surface(face, triangulation, transformation, node_count: int, is_reversed: bool):
    if not triangulation.HasNormals():
        BRepLib_ToolTriangulatedShape.ComputeNormals_s(face.wrapped, triangulation)
    node_numbers = range(1, node_count + 1)
    if transformation.Form() in TRANSFORMATION_FORMS_THAT_KEEP_DIRECTIONS:
        normal_coordinates = [triangulation.Normal(node_number).Coord() for node_number in node_numbers]
    else:
        normal_coordinates = [triangulation.Normal(node_number).Transformed(transformation).Coord()
                              for node_number in node_numbers]
    normals = np.array(normal_coordinates, np.float64).reshape(-1, 3)
    return -normals if is_reversed else normals


def _node_points_in_world_frame(triangulation, transformation, node_count: int) -> np.ndarray:
    node_numbers = range(1, node_count + 1)
    transformation_form = transformation.Form()
    if transformation_form not in TRANSFORMATION_FORMS_THAT_KEEP_DIRECTIONS:
        return np.array([triangulation.Node(node_number).Transformed(transformation).Coord()
                         for node_number in node_numbers], np.float64).reshape(-1, 3)
    local_points = np.array([triangulation.Node(node_number).Coord() for node_number in node_numbers],
                            np.float64).reshape(-1, 3)
    if transformation_form == gp_TrsfForm.gp_Identity:
        return local_points
    return local_points + np.array(transformation.TranslationPart().Coord(), np.float64)


def _triangle_corner_indices(triangulation, is_reversed: bool) -> np.ndarray:
    one_based_corners = np.array([triangulation.Triangle(triangle_number).Get()
                                  for triangle_number in range(1, triangulation.NbTriangles() + 1)],
                                 np.int64).reshape(-1, 3)
    zero_based_corners = one_based_corners - 1
    return zero_based_corners[:, [0, 2, 1]] if is_reversed else zero_based_corners


def _vertex_normals_from_triangles(points: np.ndarray, triangle_indices: np.ndarray) -> np.ndarray:
    normals = np.zeros_like(points)
    triangle_normals = np.cross(points[triangle_indices[:, 1]] - points[triangle_indices[:, 0]],
                                points[triangle_indices[:, 2]] - points[triangle_indices[:, 0]])
    for corner in range(3):
        np.add.at(normals, triangle_indices[:, corner], triangle_normals)
    return normals


def _triangulate_face(face, is_reversed: bool):
    location = TopLoc_Location()
    triangulation = BRep_Tool.Triangulation_s(face.wrapped, location)
    if triangulation is None:
        return None
    transformation = location.Transformation()
    node_count = triangulation.NbNodes()
    points = _node_points_in_world_frame(triangulation, transformation, node_count)
    triangle_indices = _triangle_corner_indices(triangulation, is_reversed)
    try:
        normals = _vertex_normals_from_surface(face, triangulation, transformation, node_count, is_reversed)
    except Exception:
        normals = _vertex_normals_from_triangles(points, triangle_indices)
    normal_lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    return points, normals / np.where(normal_lengths == 0, 1, normal_lengths), triangle_indices


def _polyline_of_edge(edge, linear_deflection: float):
    try:
        discretization = GCPnts_TangentialDeflection(BRepAdaptor_Curve(edge.wrapped),
                                                     EDGE_ANGULAR_DEFLECTION_IN_RADIANS, linear_deflection)
        points = [discretization.Value(point_number) for point_number in range(1, discretization.NbPoints() + 1)]
        if len(points) >= 2:
            return np.array([(point.X(), point.Y(), point.Z()) for point in points], np.float64)
    except Exception:
        pass
    try:
        return np.array([tuple(edge.position_at(parameter))
                         for parameter in np.linspace(0, 1, FALLBACK_EDGE_SAMPLE_COUNT)])
    except Exception:
        return None


def set_mesh_quality(quality_name: str):
    global _current_mesh_quality
    _current_mesh_quality = quality_name if quality_name in MESH_QUALITY_PRESETS else "normal"


def mesh_tolerances_for_shape(shape) -> tuple[float, float]:
    diagonal = max(shape.bounding_box(optimal=False).diagonal, 1e-6)
    diagonal_divisor, angular_tolerance = MESH_QUALITY_PRESETS[_current_mesh_quality]
    return max(diagonal / diagonal_divisor, 0.002), angular_tolerance


def _concatenated_or_empty(arrays: list, dtype=None) -> np.ndarray:
    if arrays:
        return np.concatenate(arrays)
    return np.zeros((0, 3), dtype) if dtype else np.zeros((0, 3))


def mesh_part(shape, part_id: str, name: str, color: str, lineage_token_by_face: dict | None = None) -> tuple[dict, dict]:
    linear_tolerance, angular_tolerance = mesh_tolerances_for_shape(shape)
    BRepMesh_IncrementalMesh(shape.wrapped, linear_tolerance, False, angular_tolerance, True)
    point_arrays, normal_arrays, index_arrays, face_descriptions = [], [], [], []
    vertex_offset, triangle_offset = 0, 0
    faces = shape.faces()
    persistent_ids = persistent_face_ids(faces, part_id, lineage_token_by_face)
    for face_index, (face, persistent_id) in enumerate(zip(faces, persistent_ids)):
        description = describe_face(face, f"{part_id}/f{face_index}") | {"persistent_id": persistent_id}
        triangulated = _triangulate_face(face, face.wrapped.Orientation() == TopAbs_REVERSED)
        triangle_count = len(triangulated[2]) if triangulated is not None else 0
        face_descriptions.append(description | {"start": triangle_offset, "count": triangle_count})
        if triangulated is None:
            continue
        points, normals, triangle_indices = triangulated
        point_arrays.append(points)
        normal_arrays.append(normals)
        index_arrays.append(triangle_indices + vertex_offset)
        vertex_offset, triangle_offset = vertex_offset + len(points), triangle_offset + triangle_count
    edges = shape.edges()
    part = {"id": part_id, "name": name, "color": color, "faces": face_descriptions,
            "edges": [describe_edge(edge, f"{part_id}/e{edge_index}") for edge_index, edge in enumerate(edges)]}
    buffers = {"positions": _concatenated_or_empty(point_arrays), "normals": _concatenated_or_empty(normal_arrays),
               "indices": _concatenated_or_empty(index_arrays, np.int64),
               "polylines": [_polyline_of_edge(edge, linear_tolerance) for edge in edges]}
    return part, buffers


def scene_part_with_encoded_buffers(part: dict, buffers: dict) -> dict:
    encoded_edges = [edge | {"points": base64_of_array_bytes(polyline.astype(np.float32))} if polyline is not None else dict(edge)
                     for edge, polyline in zip(part["edges"], buffers["polylines"])]
    return part | {"positions": base64_of_array_bytes(buffers["positions"].astype(np.float32)),
                   "normals": base64_of_array_bytes(buffers["normals"].astype(np.float32)),
                   "indices": base64_of_array_bytes(buffers["indices"].astype(np.uint32).ravel()),
                   "edges": encoded_edges}


def hex_color_from_rgb(color) -> str | None:
    try:
        red, green, blue = list(color)[:3]
        return "#%02x%02x%02x" % tuple(int(max(0, min(1, channel)) * 255) for channel in (red, green, blue))
    except Exception:
        return None


def _first_builder_output(builder):
    for attribute_name in ("part", "sketch", "line"):
        builder_output = getattr(builder, attribute_name, None)
        if builder_output is not None:
            return builder_output
    return None


def _child_name(child, parent_name: str, child_index: int) -> str:
    return getattr(child, "label", "") or f"{parent_name}_{child_index}"


def _iterate_leaf_parts(produced_object, name: str):
    if produced_object is None:
        return
    is_builder = hasattr(produced_object, "part") and not isinstance(produced_object, Shape)
    builder_output = _first_builder_output(produced_object) if is_builder else None
    if builder_output is not None:
        yield from _iterate_leaf_parts(builder_output, name)
    elif isinstance(produced_object, dict):
        for key, child in produced_object.items():
            yield from _iterate_leaf_parts(child, str(key))
    elif isinstance(produced_object, (list, tuple)):
        for child_index, child in enumerate(produced_object):
            yield from _iterate_leaf_parts(child, _child_name(child, name, child_index))
    elif isinstance(produced_object, Compound) and list(getattr(produced_object, "children", ()) or ()):
        for child_index, child in enumerate(produced_object.children):
            yield from _iterate_leaf_parts(child, _child_name(child, name, child_index))
    elif isinstance(produced_object, Shape):
        color = hex_color_from_rgb(produced_object.color) if getattr(produced_object, "color", None) is not None else None
        yield getattr(produced_object, "label", "") or name, produced_object, color


def flatten_into_leaf_parts(produced_object, default_name="part") -> list:
    return list(_iterate_leaf_parts(produced_object, default_name))


def bounding_box_of_shapes(shapes) -> dict:
    lowest_corner = np.array([math.inf] * 3)
    highest_corner = -lowest_corner
    for shape in shapes:
        bounding_box = shape.bounding_box(optimal=False)
        lowest_corner = np.minimum(lowest_corner, [bounding_box.min.X, bounding_box.min.Y, bounding_box.min.Z])
        highest_corner = np.maximum(highest_corner, [bounding_box.max.X, bounding_box.max.Y, bounding_box.max.Z])
    if not np.isfinite(lowest_corner).all():
        lowest_corner = highest_corner = np.zeros(3)
    return {"min": _rounded_floats(lowest_corner), "max": _rounded_floats(highest_corner)}


def build_scene_and_topology(parts: list, lineage_token_by_face: dict | None = None) -> tuple[dict, list, dict]:
    meshed_parts = [mesh_part(shape, f"p{part_index}", name, color or PART_COLOR_PALETTE[part_index % len(PART_COLOR_PALETTE)],
                              lineage_token_by_face)
                    for part_index, (name, shape, color) in enumerate(parts)]
    bounding_box = bounding_box_of_shapes([shape for _name, shape, _color in parts])
    scene = {"format": "biscad-scene", "version": 1, "units": "mm", "bbox": bounding_box,
             "parts": [scene_part_with_encoded_buffers(part, buffers) for part, buffers in meshed_parts]}
    topology = {"units": "mm", "bbox": bounding_box, "parts": [part for part, _buffers in meshed_parts]}
    return scene, [buffers for _part, buffers in meshed_parts], topology
