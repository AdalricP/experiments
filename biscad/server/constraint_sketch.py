import dataclasses
import functools
import math

import build123d
import numpy
import scipy.optimize

_RESIDUAL_TOLERANCE_FOR_SATISFIED_CONSTRAINT = 1e-6
_RELATIVE_SINGULAR_VALUE_TOLERANCE_FOR_RANK = 1e-7
_FINITE_DIFFERENCE_STEP_IN_MILLIMETERS = 1e-6
_SMALLEST_LENGTH_IN_MILLIMETERS = 1e-12
_SOLVER_TOLERANCE = 1e-15
_MAXIMUM_SOLVER_EVALUATIONS = 5000


class ConstraintSketchError(ValueError):
    pass


@dataclasses.dataclass(frozen=True)
class SketchPoint:
    point_index_in_sketch: int
    initial_x_in_millimeters: float
    initial_y_in_millimeters: float

    def __str__(self):
        return f"point {self.point_index_in_sketch}"


@dataclasses.dataclass(frozen=True)
class SketchLine:
    line_index_in_sketch: int
    start_point: SketchPoint
    end_point: SketchPoint

    def __str__(self):
        return f"line {self.line_index_in_sketch} ({self.start_point} -> {self.end_point})"


@dataclasses.dataclass(frozen=True)
class SketchCircle:
    circle_index_in_sketch: int
    center_point: SketchPoint
    initial_radius_in_millimeters: float

    def __str__(self):
        return f"circle {self.circle_index_in_sketch} (center {self.center_point})"


@dataclasses.dataclass(frozen=True)
class _SketchConstraint:
    description: str
    residuals_for_geometry: object


_POINT_TYPES, _LINE_TYPES, _CIRCLE_TYPES = (SketchPoint,), (SketchLine,), (SketchCircle,)


def _position_of(point_coordinates, point):
    return point_coordinates[point.point_index_in_sketch]


def _direction_of(point_coordinates, line):
    return _position_of(point_coordinates, line.end_point) - _position_of(point_coordinates, line.start_point)


def _cross_product_2d(first_vector, second_vector):
    return first_vector[0] * second_vector[1] - first_vector[1] * second_vector[0]


def _length_of_vector(vector):
    return max(math.hypot(vector[0], vector[1]), _SMALLEST_LENGTH_IN_MILLIMETERS)


def _length_of_line(point_coordinates, line):
    return _length_of_vector(_direction_of(point_coordinates, line))


def _sine_and_cosine_between(point_coordinates, first_line, second_line):
    first_direction = _direction_of(point_coordinates, first_line)
    second_direction = _direction_of(point_coordinates, second_line)
    length_product = _length_of_vector(first_direction) * _length_of_vector(second_direction)
    return (_cross_product_2d(first_direction, second_direction) / length_product,
            numpy.dot(first_direction, second_direction) / length_product)


def _signed_distance_from_line(point_coordinates, line, position):
    offset_from_start = position - _position_of(point_coordinates, line.start_point)
    return _cross_product_2d(_direction_of(point_coordinates, line), offset_from_start) / _length_of_line(point_coordinates, line)


def _angle_error_in_radians(point_coordinates, first_line, second_line, target_angle_in_radians):
    sine, cosine = _sine_and_cosine_between(point_coordinates, first_line, second_line)
    return math.remainder(math.atan2(sine, cosine) - target_angle_in_radians, 2 * math.pi)


def _require_entity_type(entity, expected_types, constraint_name: str):
    if not isinstance(entity, expected_types):
        expected_names = " or ".join(expected_type.__name__ for expected_type in expected_types)
        raise ConstraintSketchError(f"{constraint_name}() expects a {expected_names}, got {entity!r}")
    return entity


def _split_parameter_vector(parameter_vector, point_count: int):
    return parameter_vector[:2 * point_count].reshape(point_count, 2), parameter_vector[2 * point_count:]


def _stacked_residuals(constraints, point_count: int, parameter_vector):
    point_coordinates, circle_radii = _split_parameter_vector(parameter_vector, point_count)
    return numpy.array([residual for constraint in constraints
                        for residual in constraint.residuals_for_geometry(point_coordinates, circle_radii)], dtype=float)


def _central_difference_jacobian(residual_function, parameter_vector):
    columns = []
    for parameter_index in range(len(parameter_vector)):
        step_vector = numpy.zeros_like(parameter_vector)
        step_vector[parameter_index] = _FINITE_DIFFERENCE_STEP_IN_MILLIMETERS
        difference = residual_function(parameter_vector + step_vector) - residual_function(parameter_vector - step_vector)
        columns.append(difference / (2 * _FINITE_DIFFERENCE_STEP_IN_MILLIMETERS))
    return numpy.stack(columns, axis=1)


def _rank_of_jacobian(jacobian) -> int:
    if jacobian.size == 0:
        return 0
    singular_values = numpy.linalg.svd(jacobian, compute_uv=False)
    return int(numpy.sum(singular_values > singular_values.max() * _RELATIVE_SINGULAR_VALUE_TOLERANCE_FOR_RANK))


def _describe_unsatisfied_constraints(constraints, point_count: int, parameter_vector) -> list[str]:
    point_coordinates, circle_radii = _split_parameter_vector(parameter_vector, point_count)
    worst_errors = [max(abs(residual) for residual in constraint.residuals_for_geometry(point_coordinates, circle_radii))
                    for constraint in constraints]
    return [f"{constraint.description} off by {worst_error:.4g}"
            for constraint, worst_error in zip(constraints, worst_errors)
            if worst_error > _RESIDUAL_TOLERANCE_FOR_SATISFIED_CONSTRAINT]


def _oriented_line_endpoints(point_coordinates, line, previous_end):
    start, end = _position_of(point_coordinates, line.start_point), _position_of(point_coordinates, line.end_point)
    if previous_end is not None and numpy.linalg.norm(end - previous_end) < numpy.linalg.norm(start - previous_end):
        return end, start
    return start, end


def _closed_loop_vertices_from_lines(point_coordinates, lines) -> list:
    vertices, previous_end = [], None
    for line in lines:
        start, previous_end = _oriented_line_endpoints(point_coordinates, line, previous_end)
        vertices.append(start)
    if numpy.linalg.norm(previous_end - vertices[0]) > _RESIDUAL_TOLERANCE_FOR_SATISFIED_CONSTRAINT:
        raise ConstraintSketchError("face() needs the outer loop lines, in order, to form one closed loop")
    return vertices


def _counter_clockwise(vertices) -> list:
    signed_area = sum(_cross_product_2d(vertex, next_vertex) for vertex, next_vertex in zip(vertices, vertices[1:] + vertices[:1]))
    return vertices if signed_area > 0 else vertices[::-1]


@dataclasses.dataclass(frozen=True)
class SketchSolution:
    point_coordinates: tuple
    circle_radii: tuple
    lines: tuple
    circles: tuple
    degrees_of_freedom: int
    redundant_equation_count: int

    @property
    def is_fully_constrained(self) -> bool:
        return self.degrees_of_freedom == 0

    def position(self, point: SketchPoint) -> tuple:
        return self.point_coordinates[_require_entity_type(point, _POINT_TYPES, "position").point_index_in_sketch]

    def radius(self, circle: SketchCircle) -> float:
        return self.circle_radii[_require_entity_type(circle, _CIRCLE_TYPES, "radius").circle_index_in_sketch]

    def face(self, plane=build123d.Plane.XY, outer_loop_lines=None, hole_circles=None):
        loop_lines = tuple(self.lines if outer_loop_lines is None else outer_loop_lines)
        if len(loop_lines) < 3:
            raise ConstraintSketchError("face() needs at least three lines forming the outer loop")
        point_coordinates = numpy.array(self.point_coordinates, dtype=float)
        loop_vertices = _counter_clockwise(_closed_loop_vertices_from_lines(point_coordinates, loop_lines))
        outer_wire = build123d.Wire.make_polygon([(vertex[0], vertex[1], 0) for vertex in loop_vertices], close=True)
        hole_wires = [build123d.Wire.make_circle(self.radius(circle), build123d.Plane(origin=(*self.position(circle.center_point), 0)))
                      for circle in (self.circles if hole_circles is None else hole_circles)]
        return build123d.Face(outer_wire, hole_wires).moved(plane.location)


class ConstraintSketch:
    def __init__(self):
        self._points, self._lines, self._circles, self._constraints = [], [], [], []

    def _constrain(self, constraint_name: str, entities_with_expected_types, residuals_for_geometry, *dimension_values):
        entities = [_require_entity_type(entity, expected_types, constraint_name) for entity, expected_types in entities_with_expected_types]
        argument_text = ", ".join([str(entity) for entity in entities] + [str(dimension) for dimension in dimension_values])
        self._constraints.append(_SketchConstraint(f"#{len(self._constraints)} {constraint_name}({argument_text})", residuals_for_geometry))

    def point(self, x_in_millimeters: float, y_in_millimeters: float, fixed: bool = False) -> SketchPoint:
        self._points.append(SketchPoint(len(self._points), float(x_in_millimeters), float(y_in_millimeters)))
        if fixed:
            self.fixed(self._points[-1])
        return self._points[-1]

    def line(self, start_point: SketchPoint, end_point: SketchPoint) -> SketchLine:
        self._lines.append(SketchLine(len(self._lines), _require_entity_type(start_point, _POINT_TYPES, "line"),
                                      _require_entity_type(end_point, _POINT_TYPES, "line")))
        return self._lines[-1]

    def circle(self, center_point: SketchPoint, radius: float) -> SketchCircle:
        self._circles.append(SketchCircle(len(self._circles), _require_entity_type(center_point, _POINT_TYPES, "circle"), float(radius)))
        return self._circles[-1]

    def fixed(self, point: SketchPoint):
        _require_entity_type(point, _POINT_TYPES, "fixed")
        anchor = numpy.array([point.initial_x_in_millimeters, point.initial_y_in_millimeters])
        self._constrain("fixed", [(point, _POINT_TYPES)], lambda coordinates, radii: _position_of(coordinates, point) - anchor)

    def coincident(self, first_point: SketchPoint, second_point: SketchPoint):
        self._constrain("coincident", [(first_point, _POINT_TYPES), (second_point, _POINT_TYPES)], lambda coordinates, radii:
                        _position_of(coordinates, first_point) - _position_of(coordinates, second_point))

    def horizontal(self, line: SketchLine):
        self._constrain("horizontal", [(line, _LINE_TYPES)], lambda coordinates, radii: [_direction_of(coordinates, line)[1]])

    def vertical(self, line: SketchLine):
        self._constrain("vertical", [(line, _LINE_TYPES)], lambda coordinates, radii: [_direction_of(coordinates, line)[0]])

    def parallel(self, first_line: SketchLine, second_line: SketchLine):
        self._constrain("parallel", [(first_line, _LINE_TYPES), (second_line, _LINE_TYPES)], lambda coordinates, radii:
                        [_sine_and_cosine_between(coordinates, first_line, second_line)[0]])

    def perpendicular(self, first_line: SketchLine, second_line: SketchLine):
        self._constrain("perpendicular", [(first_line, _LINE_TYPES), (second_line, _LINE_TYPES)], lambda coordinates, radii:
                        [_sine_and_cosine_between(coordinates, first_line, second_line)[1]])

    def length(self, line: SketchLine, length_in_millimeters: float):
        self._constrain("length", [(line, _LINE_TYPES)], lambda coordinates, radii:
                        [_length_of_line(coordinates, line) - length_in_millimeters], length_in_millimeters)

    def distance(self, first_point: SketchPoint, second_point: SketchPoint, distance_in_millimeters: float):
        self._constrain("distance", [(first_point, _POINT_TYPES), (second_point, _POINT_TYPES)], lambda coordinates, radii: [_length_of_vector(
            _position_of(coordinates, first_point) - _position_of(coordinates, second_point)) - distance_in_millimeters],
            distance_in_millimeters)

    def equal(self, first_entity, second_entity):
        if isinstance(first_entity, SketchCircle):
            self._constrain("equal", [(first_entity, _CIRCLE_TYPES), (second_entity, _CIRCLE_TYPES)], lambda coordinates, radii:
                            [radii[first_entity.circle_index_in_sketch] - radii[second_entity.circle_index_in_sketch]])
            return
        self._constrain("equal", [(first_entity, _LINE_TYPES), (second_entity, _LINE_TYPES)], lambda coordinates, radii:
                        [_length_of_line(coordinates, first_entity) - _length_of_line(coordinates, second_entity)])

    def angle(self, first_line: SketchLine, second_line: SketchLine, degrees: float):
        self._constrain("angle", [(first_line, _LINE_TYPES), (second_line, _LINE_TYPES)], lambda coordinates, radii:
                        [_angle_error_in_radians(coordinates, first_line, second_line, math.radians(degrees))], f"{degrees} degrees")

    def radius(self, circle: SketchCircle, radius_in_millimeters: float):
        self._constrain("radius", [(circle, _CIRCLE_TYPES)], lambda coordinates, radii:
                        [radii[circle.circle_index_in_sketch] - radius_in_millimeters], radius_in_millimeters)

    def tangent(self, line: SketchLine, circle: SketchCircle):
        self._constrain("tangent", [(line, _LINE_TYPES), (circle, _CIRCLE_TYPES)], lambda coordinates, radii: [abs(_signed_distance_from_line(
            coordinates, line, _position_of(coordinates, circle.center_point))) - radii[circle.circle_index_in_sketch]])

    def midpoint(self, point: SketchPoint, line: SketchLine):
        self._constrain("midpoint", [(point, _POINT_TYPES), (line, _LINE_TYPES)], lambda coordinates, radii: _position_of(coordinates, point)
                        - (_position_of(coordinates, line.start_point) + _position_of(coordinates, line.end_point)) / 2)

    def point_on_line(self, point: SketchPoint, line: SketchLine):
        self._constrain("point_on_line", [(point, _POINT_TYPES), (line, _LINE_TYPES)], lambda coordinates, radii:
                        [_signed_distance_from_line(coordinates, line, _position_of(coordinates, point))])

    def solve(self) -> SketchSolution:
        initial_parameter_vector = numpy.array(
            [coordinate for point in self._points for coordinate in (point.initial_x_in_millimeters, point.initial_y_in_millimeters)]
            + [circle.initial_radius_in_millimeters for circle in self._circles], dtype=float)
        residual_function = functools.partial(_stacked_residuals, tuple(self._constraints), len(self._points))
        solved_parameter_vector = _least_squares_solution(residual_function, initial_parameter_vector)
        unsatisfied_descriptions = _describe_unsatisfied_constraints(self._constraints, len(self._points), solved_parameter_vector)
        if unsatisfied_descriptions:
            first_conflict = self._constraints[_first_conflicting_constraint_index(self._constraints, len(self._points), initial_parameter_vector)]
            raise ConstraintSketchError(
                f"sketch is over-constrained or conflicting: {first_conflict.description} cannot hold together with the "
                f"constraints added before it. Unsatisfied after solving ({len(unsatisfied_descriptions)} of "
                f"{len(self._constraints)}): {'; '.join(unsatisfied_descriptions)}. Remove or change one of them.")
        jacobian_rank = _rank_of_jacobian(_central_difference_jacobian(residual_function, solved_parameter_vector))
        point_coordinates, circle_radii = _split_parameter_vector(solved_parameter_vector, len(self._points))
        return SketchSolution(tuple(tuple(float(coordinate) for coordinate in position) for position in point_coordinates),
                              tuple(float(radius) for radius in circle_radii), tuple(self._lines), tuple(self._circles),
                              len(solved_parameter_vector) - jacobian_rank,
                              len(residual_function(solved_parameter_vector)) - jacobian_rank)


def _least_squares_solution(residual_function, initial_parameter_vector):
    if len(residual_function(initial_parameter_vector)) == 0 or len(initial_parameter_vector) == 0:
        return initial_parameter_vector
    return scipy.optimize.least_squares(residual_function, initial_parameter_vector, method="trf", xtol=_SOLVER_TOLERANCE,
                                        ftol=_SOLVER_TOLERANCE, gtol=_SOLVER_TOLERANCE,
                                        max_nfev=_MAXIMUM_SOLVER_EVALUATIONS).x


def _is_prefix_of_constraints_satisfiable(constraints, point_count: int, initial_parameter_vector, prefix_length: int) -> bool:
    prefix_constraints = tuple(constraints[:prefix_length])
    residual_function = functools.partial(_stacked_residuals, prefix_constraints, point_count)
    solved_parameter_vector = _least_squares_solution(residual_function, initial_parameter_vector)
    return not _describe_unsatisfied_constraints(prefix_constraints, point_count, solved_parameter_vector)


def _first_conflicting_constraint_index(constraints, point_count: int, initial_parameter_vector) -> int:
    satisfiable_prefix_length, failing_prefix_length = 0, len(constraints)
    while failing_prefix_length - satisfiable_prefix_length > 1:
        middle_prefix_length = (satisfiable_prefix_length + failing_prefix_length) // 2
        if _is_prefix_of_constraints_satisfiable(constraints, point_count, initial_parameter_vector, middle_prefix_length):
            satisfiable_prefix_length = middle_prefix_length
            continue
        failing_prefix_length = middle_prefix_length
    return failing_prefix_length - 1
