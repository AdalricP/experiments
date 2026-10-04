from __future__ import annotations

import hashlib

from build123d import Face
from build123d.topology.shape_core import _topods_entities
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Torus
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopLoc import TopLoc_Location

PERSISTENT_TOKEN_HEX_DIGIT_COUNT = 8
DIRECTION_DECIMAL_PLACES = 3
CENTER_DECIMAL_PLACES_FOR_ORDERING = 2
GEOMETRY_ONLY_LINEAGE = "geometry"
PERSISTENT_REFERENCE_MARKER = "/#"
AXIS_OF_REVOLVED_SURFACE_TYPES = {GeomAbs_Cylinder: lambda surface: surface.Cylinder().Axis(),
                                  GeomAbs_Cone: lambda surface: surface.Cone().Axis(),
                                  GeomAbs_Torus: lambda surface: surface.Torus().Axis()}


def short_hash_of_text(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:PERSISTENT_TOKEN_HEX_DIGIT_COUNT]


def _direction_text(direction, should_ignore_sign: bool) -> str:
    components = [round(component, DIRECTION_DECIMAL_PLACES) + 0.0 for component in direction.Coord()]
    first_nonzero_component = next((component for component in components if component), 1.0)
    if should_ignore_sign and first_nonzero_component < 0:
        components = [0.0 - component for component in components]
    return ",".join(f"{component:g}" for component in components)


def face_geometry_signature(face) -> str:
    surface = BRepAdaptor_Surface(face.wrapped)
    surface_type = surface.GetType()
    type_name = surface_type.name.removeprefix("GeomAbs_").lower()
    if surface_type == GeomAbs_Plane:
        normal = surface.Plane().Axis().Direction()
        is_reversed = face.wrapped.Orientation() == TopAbs_REVERSED
        return f"{type_name}:{_direction_text(normal.Reversed() if is_reversed else normal, False)}"
    if surface_type in AXIS_OF_REVOLVED_SURFACE_TYPES:
        axis = AXIS_OF_REVOLVED_SURFACE_TYPES[surface_type](surface)
        return f"{type_name}:{_direction_text(axis.Direction(), True)}"
    return type_name


def _rounded_center_and_area_for_ordering(face) -> tuple:
    return (*(round(coordinate, CENTER_DECIMAL_PLACES_FOR_ORDERING) for coordinate in face.center()),
            round(face.area, CENTER_DECIMAL_PLACES_FOR_ORDERING))


def _faces_grouped_by_signature(faces: list) -> dict:
    faces_by_signature = {}
    for face in faces:
        faces_by_signature.setdefault(face_geometry_signature(face), []).append(face)
    return faces_by_signature


def fresh_tokens_for_faces(lineage_key: str, faces: list) -> dict:
    tokens_by_face = {}
    for signature, faces_with_signature in sorted(_faces_grouped_by_signature(faces).items()):
        ordered_faces = sorted(faces_with_signature, key=_rounded_center_and_area_for_ordering) \
            if len(faces_with_signature) > 1 else faces_with_signature
        for occurrence_number, face in enumerate(ordered_faces):
            tokens_by_face[face] = short_hash_of_text(f"{lineage_key}|{signature}|{occurrence_number}")
    return tokens_by_face


def face_without_location(face) -> Face:
    return Face(face.wrapped.Located(TopLoc_Location()))


def lookup_token_of_face(token_by_face: dict, face) -> str | None:
    return token_by_face.get(face) or token_by_face.get(face_without_location(face))


def _named_input_faces(token_by_face: dict, history) -> list[tuple]:
    input_faces = [Face(topods_face) for input_shape in [*history.before, *history.brought]
                   for topods_face in _topods_entities(input_shape, "Face")]
    return [(face, token) for face in input_faces if (token := lookup_token_of_face(token_by_face, face))]


def _inherited_tokens_through_history(token_by_face: dict, history) -> dict:
    candidate_tokens_by_face = {}
    for input_face, input_token in _named_input_faces(token_by_face, history):
        for successor in history.modified(input_face.wrapped):
            candidate_tokens_by_face.setdefault(Face(successor), set()).add(input_token)
    return {face: min(candidate_tokens) for face, candidate_tokens in candidate_tokens_by_face.items()}


def tokens_after_operation(token_by_face: dict, part_after, history, lineage_key: str) -> dict:
    inherited_tokens = _inherited_tokens_through_history(token_by_face, history) if history is not None else {}
    tokens_by_face = {}
    new_faces = []
    for face in part_after.faces():
        known_token = lookup_token_of_face(token_by_face, face) or inherited_tokens.get(face)
        if known_token is None:
            new_faces.append(face)
            continue
        tokens_by_face[face] = known_token
    return tokens_by_face | fresh_tokens_for_faces(lineage_key, new_faces)


def remembered_entries_for_tokens(tokens_by_face: dict) -> dict:
    return {key: token for face, token in tokens_by_face.items() for key in (face_without_location(face), face)}


def _unique_tokens(faces: list, tokens: list[str]) -> list[str]:
    faces_by_token = {}
    for face, token in zip(faces, tokens):
        faces_by_token.setdefault(token, []).append(face)
    unique_token_by_face = {}
    for token, faces_sharing_token in faces_by_token.items():
        ordered_faces = sorted(faces_sharing_token, key=_rounded_center_and_area_for_ordering) \
            if len(faces_sharing_token) > 1 else faces_sharing_token
        for piece_number, face in enumerate(ordered_faces):
            unique_token_by_face[face] = token if piece_number == 0 else short_hash_of_text(f"{token}|{piece_number}")
    return [unique_token_by_face[face] for face in faces]


def persistent_face_ids(faces: list, part_id: str, token_by_face: dict | None) -> list[str]:
    known_tokens = [lookup_token_of_face(token_by_face or {}, face) for face in faces]
    fallback_tokens = fresh_tokens_for_faces(GEOMETRY_ONLY_LINEAGE,
                                             [face for face, token in zip(faces, known_tokens) if token is None])
    tokens = [token or fallback_tokens[face] for face, token in zip(faces, known_tokens)]
    return [f"{part_id}/#{token}" for token in _unique_tokens(faces, tokens)]


def is_persistent_reference(reference: str) -> bool:
    return PERSISTENT_REFERENCE_MARKER in str(reference)


def index_reference_for(reference: str, topology: dict) -> str:
    if not is_persistent_reference(reference):
        return reference
    matching_index_ids = [face["id"] for part in topology["parts"] for face in part["faces"]
                          if face.get("persistent_id") == reference.strip()]
    return matching_index_ids[0] if matching_index_ids else reference
