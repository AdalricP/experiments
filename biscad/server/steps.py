from __future__ import annotations

import contextlib
import sys

from build123d import BuildPart, Mode, Shape, build_common

from persistent_naming import remembered_entries_for_tokens, tokens_after_operation

OPERATION_VERBS = {
    "extrude": "Extrude", "revolve": "Revolve", "loft": "Loft", "sweep": "Sweep",
    "fillet": "Fillet", "chamfer": "Chamfer", "offset": "Shell", "mirror": "Mirror",
    "split": "Split", "thicken": "Thicken", "section": "Section", "project": "Project",
    "make_brake_formed": "Bend", "add": "Add", "scale": "Scale",
    "Box": "Add a box", "Cylinder": "Add a cylinder", "Sphere": "Add a sphere", "Cone": "Add a cone",
    "Torus": "Add a torus", "Wedge": "Add a wedge", "Hole": "Drill a hole",
    "CounterBoreHole": "Drill a counterbored hole", "CounterSinkHole": "Drill a countersunk hole",
}
OPERATION_ICONS = {
    "extrude": "extrude", "revolve": "revolve", "loft": "loft", "sweep": "sweep", "fillet": "fillet",
    "chamfer": "chamfer", "offset": "shell", "mirror": "mirror", "split": "split", "Hole": "hole",
    "CounterBoreHole": "hole", "CounterSinkHole": "hole", "Box": "primitive", "Cylinder": "primitive",
    "Sphere": "primitive", "Cone": "primitive", "Torus": "primitive", "Wedge": "primitive",
}
OPERATION_LABELS = {"CounterBoreHole": "counterbored hole", "CounterSinkHole": "countersunk hole", "Hole": "hole",
                    "offset": "shell", "make_brake_formed": "bend", "Box": "box", "Cylinder": "cylinder",
                    "Sphere": "sphere", "Cone": "cone", "Torus": "torus", "Wedge": "wedge"}
RECORDED_ARGUMENT_NAMES = ("amount", "radius", "length", "width", "height", "depth", "angle", "revolution_arc",
                           "counter_bore_radius", "counter_sink_radius", "length2", "thickness", "until")
SHAPE_DIMENSION_ATTRIBUTES = (("radius", "radius"), ("length", "length"), ("width", "width"), ("height", "height"),
                              ("height", "cylinder_height"), ("depth", "hole_depth"), ("angle", "angle"))
DECORATOR_FUNCTION_NAMES = ("wrapper", "wrapped", "inner")
HOLE_OPERATIONS = ("Hole", "CounterBoreHole", "CounterSinkHole")
MAX_RECORDED_STEPS = 80


def _format_argument_value(raw_value):
    if isinstance(raw_value, bool) or raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return f"{raw_value:g}"
    enum_name = getattr(raw_value, "name", None)
    return enum_name.lower() if isinstance(enum_name, str) else None


def _library_frames_below_script(starting_frame):
    library_frames = []
    frame = starting_frame
    while frame is not None and frame.f_code.co_filename != "<script>":
        library_frames.append(frame)
        frame = frame.f_back
    return library_frames, (frame.f_lineno if frame is not None else None)


def _shape_dimension_arguments(shape) -> dict:
    arguments = {}
    for argument_name, attribute_name in SHAPE_DIMENSION_ATTRIBUTES:
        formatted = None if argument_name in arguments else _format_argument_value(getattr(shape, attribute_name, None))
        if formatted is not None and formatted != "0" and len(formatted) < 20:
            arguments[argument_name] = formatted
    return arguments


def _identify_operation(library_frames: list):
    script_side_first = list(reversed(library_frames))
    for frame in script_side_first:
        frame_self = frame.f_locals.get("self")
        if isinstance(frame_self, Shape):
            return type(frame_self).__name__, frame, _shape_dimension_arguments(frame_self)
    for frame in script_side_first:
        function_name = frame.f_code.co_name
        if not function_name.startswith("_") and function_name not in DECORATOR_FUNCTION_NAMES:
            return function_name, frame, {}
    if not library_frames:
        return "operation", None, {}
    function_name = library_frames[-1].f_code.co_name
    return ("sketch" if function_name == "__exit__" else function_name.strip("_")), None, {}


def _arguments_from_frame_locals(frame_locals, operation: str) -> dict:
    arguments = {}
    for argument_name in RECORDED_ARGUMENT_NAMES:
        formatted = _format_argument_value(frame_locals[argument_name]) if argument_name in frame_locals else None
        if formatted is not None:
            arguments[argument_name] = formatted
    if "objects" in frame_locals and operation in ("fillet", "chamfer"):
        with contextlib.suppress(Exception):
            arguments["count"] = str(len(list(frame_locals["objects"])))
    return arguments


def _without_through_hole_depth(arguments: dict, operation: str, part) -> dict:
    if "depth" not in arguments or not operation.endswith("Hole"):
        return arguments
    try:
        is_through_hole = float(arguments["depth"]) >= 0.9 * part.bounding_box().diagonal
    except Exception:
        return arguments
    return {name: formatted for name, formatted in arguments.items() if name != "depth"} if is_through_hole else arguments


class StepRecorder:
    def __init__(self):
        self.steps = []
        self.lineage_token_by_face = {}
        self._builders_in_order = []
        self._operation_counts_by_lineage_prefix = {}
        self._original_add_to_context = None

    def install(self):
        original_add_to_context = build_common.Builder._add_to_context
        self._original_add_to_context = original_add_to_context
        recorder = self

        def add_to_context_and_record_step(builder, *objects, **keyword_arguments):
            part_before = builder._obj if isinstance(builder, BuildPart) else None
            add_outcome = original_add_to_context(builder, *objects, **keyword_arguments)
            recorder._observe_operation(builder, part_before, keyword_arguments.get("mode", Mode.ADD), sys._getframe(1))
            return add_outcome

        build_common.Builder._add_to_context = add_to_context_and_record_step

    def uninstall(self):
        if self._original_add_to_context is not None:
            build_common.Builder._add_to_context = self._original_add_to_context

    def _observe_operation(self, builder, part_before, mode, calling_frame):
        if not isinstance(builder, BuildPart) or mode == Mode.PRIVATE or builder._obj is None \
                or builder._obj is part_before:
            return
        with contextlib.suppress(Exception):
            self._name_faces_and_record_step(builder, mode, calling_frame)

    def _name_faces_and_record_step(self, builder, mode, calling_frame):
        library_frames, script_line_number = _library_frames_below_script(calling_frame)
        operation, source_frame, arguments = _identify_operation(library_frames)
        with contextlib.suppress(Exception):
            self._remember_face_lineage(builder, operation)
        if len(self.steps) < MAX_RECORDED_STEPS:
            self._record(builder, mode, operation, source_frame, arguments, script_line_number)

    def _lineage_key_of_operation(self, builder, operation: str) -> str:
        if not any(known_builder is builder for known_builder in self._builders_in_order):
            self._builders_in_order.append(builder)
        builder_ordinal = next(ordinal for ordinal, known_builder in enumerate(self._builders_in_order)
                               if known_builder is builder)
        lineage_prefix = f"{builder_ordinal}:{operation}"
        operation_ordinal = self._operation_counts_by_lineage_prefix.get(lineage_prefix, 0)
        self._operation_counts_by_lineage_prefix[lineage_prefix] = operation_ordinal + 1
        return f"{lineage_prefix}:{operation_ordinal}"

    def _remember_face_lineage(self, builder, operation: str):
        tokens_by_face = tokens_after_operation(self.lineage_token_by_face, builder._obj,
                                                getattr(builder._obj, "_history", None),
                                                self._lineage_key_of_operation(builder, operation))
        self.lineage_token_by_face |= remembered_entries_for_tokens(tokens_by_face)

    def _record(self, builder, mode, operation, source_frame, arguments, script_line_number):
        if source_frame is not None:
            arguments = arguments | _arguments_from_frame_locals(source_frame.f_locals, operation)
        part = builder.part
        self.steps.append({
            "op": operation, "mode": getattr(mode, "name", str(mode)).lower(), "line": script_line_number,
            "args": _without_through_hole_depth(arguments, operation, part), "builder": id(builder), "shape": part,
        })


def _count_phrase_for_edges(edge_count: str | None) -> str:
    if edge_count == "1":
        return "1 edge"
    return f"{edge_count} edges" if edge_count else "the edges"


def _diameter_text(radius: str | None) -> str | None:
    return f"{float(radius) * 2:g}" if radius else None


def _first_sentence_for_operation(operation: str, mode: str, arguments: dict, verb: str) -> str:
    if operation == "extrude":
        amount = arguments.get("amount")
        if mode == "subtract":
            return f"Cut the sketch {amount} mm into the part." if amount else "Cut the sketch into the part."
        return f"Extrude the sketch {amount} mm." if amount else "Extrude the sketch."
    if operation == "revolve":
        return f"Revolve the sketch {arguments.get('revolution_arc', '360')}°."
    if operation in ("fillet", "chamfer"):
        size = arguments.get("radius") or arguments.get("length")
        size_clause = f" with {'radius' if operation == 'fillet' else 'size'} {size} mm." if size else "."
        return f"{verb} {_count_phrase_for_edges(arguments.get('count'))}" + size_clause
    if operation == "offset":
        return f"Shell the part. Wall thickness is {arguments.get('amount', '?').lstrip('-')} mm."
    if operation in HOLE_OPERATIONS:
        diameter = _diameter_text(arguments.get("radius"))
        depth_clause = f", {arguments['depth']} mm deep." if arguments.get("depth") else ", through the part."
        return verb + (f" of diameter {diameter} mm" if diameter else "") + depth_clause
    if operation == "Box":
        return (f"Add a box {arguments.get('length', '?')} × {arguments.get('width', '?')} × "
                f"{arguments.get('height', '?')} mm.")
    if operation == "Cylinder":
        diameter = _diameter_text(arguments.get("radius"))
        return (f"Add a cylinder of diameter {diameter} mm, height {arguments.get('height', '?')} mm."
                if diameter else "Add a cylinder.")
    if operation == "Sphere":
        diameter = _diameter_text(arguments.get("radius"))
        return f"Add a sphere of diameter {diameter} mm." if diameter else "Add a sphere."
    return f"{verb}."


def _with_mode_consequence(sentence: str, operation: str, mode: str) -> str:
    if mode == "subtract" and operation != "extrude" and not operation.endswith("Hole"):
        return sentence.rstrip(".") + ". Remove this material."
    if mode == "intersect":
        return sentence.rstrip(".") + ". Keep only the overlap."
    return sentence


def describe_step_in_plain_english(step: dict, previous_volume: float | None, volume: float, face_count: int) -> str:
    operation, mode, arguments = step["op"], step["mode"], step["args"]
    volume_change = volume - (previous_volume or 0.0)
    verb = OPERATION_VERBS.get(operation, operation.replace("_", " ").capitalize())
    sentences = [_with_mode_consequence(_first_sentence_for_operation(operation, mode, arguments, verb), operation, mode)]
    if abs(volume_change) > 1e-6:
        sentences.append(f"Volume {'increases' if volume_change > 0 else 'decreases'} by {abs(volume_change):,.0f} mm³.")
    sentences.append(f"The part has {face_count} faces.")
    return " ".join(sentences)


def _volume_and_face_count(shape) -> tuple[float, int]:
    try:
        return float(shape.volume), len(shape.faces())
    except Exception:
        return 0.0, 0


def _step_metadata(step_index: int, step: dict, previous: tuple | None, volume: float, face_count: int) -> dict:
    operation = step["op"]
    icon = OPERATION_ICONS.get(operation, operation if operation in OPERATION_ICONS.values() else "operation")
    return {
        "index": step_index, "op": operation, "label": OPERATION_LABELS.get(operation, operation.replace("_", " ")),
        "icon": icon, "mode": step["mode"], "line": step["line"], "args": step["args"],
        "volume": round(volume, 3), "faces": face_count, "builder": step["builder"],
        "description": describe_step_in_plain_english(step, previous[0] if previous else None, volume, face_count),
    }


def finalize_recorded_steps(recorder: StepRecorder) -> list[tuple[dict, object]]:
    finalized_steps = []
    previous_volume_and_faces_by_builder = {}
    for step in recorder.steps:
        volume, face_count = _volume_and_face_count(step["shape"])
        previous = previous_volume_and_faces_by_builder.get(step["builder"])
        if previous is not None and abs(volume - previous[0]) < 1e-6 and face_count == previous[1]:
            continue
        finalized_steps.append((_step_metadata(len(finalized_steps), step, previous, volume, face_count), step["shape"]))
        previous_volume_and_faces_by_builder[step["builder"]] = (volume, face_count)
    small_builder_numbers = {}
    for step_metadata, _shape in finalized_steps:
        step_metadata["builder"] = small_builder_numbers.setdefault(step_metadata["builder"], len(small_builder_numbers))
    return finalized_steps
