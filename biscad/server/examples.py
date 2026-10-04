BRACKET = '''\
from build123d import *

params = {"width": 60, "height": 40, "thickness": 6, "hole": 6.5, "fillet": 5}

w, h, t = params["width"], params["height"], params["thickness"]
with BuildPart() as bracket:
    with BuildSketch(Plane.XZ):
        with BuildLine():
            Polyline((0, 0), (w, 0), (w, t), (t, t), (t, h), (0, h), close=True)
        make_face()
    extrude(amount=w * 0.4, both=True)
    # round the inside corner where the base meets the upright
    fillet(bracket.edges().filter_by(Axis.Y).sort_by_distance((t, 0, t))[0], params["fillet"])
    # four bolt holes in the base
    with Locations((w / 2 + t / 2, 0, t)):
        with GridLocations(w * 0.45, w * 0.45, 2, 2):
            Hole(params["hole"] / 2)
    # two holes through the upright
    with Locations(Plane.YZ.offset(t)):
        with GridLocations(w * 0.45, 0, 2, 1):
            with Locations((0, h * 0.62)):
                Hole(params["hole"] / 2)
    chamfer(bracket.edges().filter_by(Axis.Z).group_by(Axis.X)[-1], 2)
    fillet(bracket.edges().filter_by(Axis.Y).sort_by_distance((0, 0, h))[0], 3)

result = bracket.part
'''

FLANGE = '''\
from build123d import *

params = {"bore": 22, "flange_d": 90, "hub_d": 46, "bolts": 6, "height": 28}

with BuildPart() as flange:
    Cylinder(params["flange_d"] / 2, 8, align=(Align.CENTER, Align.CENTER, Align.MIN))
    Cylinder(params["hub_d"] / 2, params["height"], align=(Align.CENTER, Align.CENTER, Align.MIN))
    fillet(flange.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[1].sort_by(SortBy.RADIUS)[0], 4)
    Hole(params["bore"] / 2)
    with Locations((0, 0, 8)):
        with PolarLocations(params["flange_d"] / 2 - 9, params["bolts"]):
            CounterBoreHole(3.3, 5.5, 3)
    chamfer(flange.edges().group_by(Axis.Z)[-1], 1)

result = flange.part
'''

GEAR = '''\
from build123d import *
import math

params = {"teeth": 24, "module": 2.0, "width": 10, "bore": 8}

z, m = int(params["teeth"]), params["module"]
rp = z * m / 2              # pitch radius
ra = rp + m                 # addendum
rf = rp - 1.25 * m          # dedendum
rb = rp * math.cos(math.radians(20))

def involute(r_base, r):
    a = math.sqrt(max(r * r / (r_base * r_base) - 1, 0))
    return a - math.atan(a)

half = math.pi / (2 * z) + involute(rb, rp)
pts = []
for i in range(z):
    c = i * 2 * math.pi / z
    flank = [max(rf, rb) + (ra - max(rf, rb)) * k / 6 for k in range(7)]
    left = [(r, c - half + involute(rb, r)) for r in flank]
    right = [(r, c + half - involute(rb, r)) for r in reversed(flank)]
    pts += [(rf, c - half - 0.6 / z)] + left + right + [(rf, c + half + 0.6 / z)]
xy = [(r * math.cos(a), r * math.sin(a)) for r, a in pts]

with BuildPart() as gear:
    with BuildSketch():
        with BuildLine():
            Polyline(*xy, close=True)
        make_face()
    extrude(amount=params["width"])
    Hole(params["bore"] / 2)
    with Locations((0, 0, params["width"])):
        with PolarLocations(rp * 0.55, 5):
            Hole(rp * 0.14)

result = gear.part
'''

LEG = '''\
from build123d import *

# A quadruped leg: hip actuator, thigh, knee actuator, shin, foot.
params = {"thigh": 120, "shin": 130, "motor_d": 62, "motor_w": 34}

def actuator(d, w):
    with BuildPart() as a:
        Cylinder(d / 2, w, rotation=(90, 0, 0))
        with Locations(Plane.XZ.offset(w / 2)):
            Cylinder(d * 0.22, 6, align=(Align.CENTER, Align.CENTER, Align.MIN))
        fillet(a.edges().filter_by(GeomType.CIRCLE).sort_by(SortBy.RADIUS)[-2:], 3)
        with Locations(Plane.XZ.offset(-w / 2)):
            with PolarLocations(d * 0.36, 8):
                Hole(1.6, 4)
    return a.part

def link(length, w0, w1, t):
    with BuildPart() as l:
        with BuildSketch(Plane.XZ):
            with BuildLine():
                Polyline((-w0 / 2, 0), (w0 / 2, 0), (w1 / 2, -length), (-w1 / 2, -length), close=True)
            make_face()
            with Locations((0, 0), (0, -length)):
                Circle(w0 / 2 if False else w1 / 2 + 4)
        extrude(amount=t / 2, both=True)
        with BuildSketch(Plane.XZ) as cut:
            with Locations((0, -length / 2)):
                SlotCenterToCenter(length * 0.45, w1 * 0.45, rotation=90)
        extrude(amount=t, both=True, mode=Mode.SUBTRACT)
        fillet(l.edges().filter_by(Axis.Y), 1.2)
    return l.part

d, w = params["motor_d"], params["motor_w"]
hip = actuator(d, w)
hip.label, hip.color = "hip actuator", Color(0.29, 0.29, 0.29)
thigh = link(params["thigh"], 34, 26, 10).moved(Location((0, w / 2 + 8, 0)))
thigh.label, thigh.color = "thigh", Color(0.86, 0.85, 0.82)
knee = actuator(d * 0.85, w * 0.9).moved(Location((0, w / 2 + 8 + w * 0.45 + 6, -params["thigh"])))
knee.label, knee.color = "knee actuator", Color(0.29, 0.29, 0.29)
shin = link(params["shin"], 24, 16, 8).moved(Location((0, w + 24, -params["thigh"])) * Rotation(0, 25, 0))
shin.label, shin.color = "shin", Color(0.86, 0.85, 0.82)
tip = shin.vertices().sort_by(Axis.Z)[0]
foot = Sphere(13).moved(Location((tip.X, w + 24, tip.Z + 4)))
foot.label, foot.color = "foot", Color(0.12, 0.12, 0.12)

result = Compound(label="leg", children=[hip, thigh, knee, shin, foot])
'''

ENCLOSURE = '''\
from build123d import *

params = {"length": 110, "width": 70, "height": 32, "wall": 2.4, "corner": 8}

L, W, H, t = params["length"], params["width"], params["height"], params["wall"]
with BuildPart() as box:
    with BuildSketch():
        RectangleRounded(L, W, params["corner"])
    extrude(amount=H)
    fillet(box.edges().group_by(Axis.Z)[0], 3)
    offset(amount=-t, openings=box.faces().sort_by(Axis.Z)[-1])
    # screw bosses
    with BuildSketch(Plane.XY.offset(t)):
        with GridLocations(L - 16, W - 16, 2, 2):
            Circle(4.2)
            Circle(1.4, mode=Mode.SUBTRACT)
    extrude(amount=H - t - 3)
    # vent slots
    with BuildSketch(Plane.XZ.offset(-W / 2)) as vents:
        with GridLocations(7, 0, 8, 1):
            with Locations((0, H * 0.55)):
                SlotCenterToCenter(10, 2.6, rotation=90)
    extrude(amount=t * 3, both=True, mode=Mode.SUBTRACT)

result = box.part
'''

QUADRUPED = '''\
from build123d import *
import math

# Quadruped robot: shell body, four 2-DOF legs with hip/knee actuators.
params = {"body_length": 380, "body_width": 190, "body_height": 105, "thigh": 150, "shin": 165,
          "hip_angle": 28, "knee_angle": 58, "stance": 330}

SHELL = Color(0.87, 0.86, 0.83)
MOTOR = Color(0.27, 0.27, 0.28)
RUBBER = Color(0.08, 0.08, 0.08)
L, W, H = params["body_length"], params["body_width"], params["body_height"]
Z0 = params["stance"]                      # height of the hip axes

def actuator(r, w, label):
    with BuildPart() as a:
        Cylinder(r, w, rotation=(90, 0, 0))
        fillet(a.edges(), 4)
        # output face: raised ring + bolt circle
        with BuildSketch(Plane.XZ.offset(w / 2)):
            Circle(r * 0.62)
            Circle(r * 0.40, mode=Mode.SUBTRACT)
        extrude(amount=3)
        with Locations(Plane.XZ.offset(w / 2 + 3)):
            with PolarLocations(r * 0.51, 8):
                Hole(2.2, 6)
        # cooling fins on the back
        with BuildSketch(Plane.XZ.offset(-w / 2)):
            with PolarLocations(r * 0.75, 12):
                Rectangle(r * 0.32, 3)
        extrude(amount=-2.5)
    p = a.part
    p.label, p.color = label, MOTOR
    return p

def link(p1, p2, w1, w2, t, y, label):
    (x1, z1), (x2, z2) = p1, p2
    length = math.hypot(x2 - x1, z2 - z1)
    ang = math.degrees(math.atan2(z2 - z1, x2 - x1))
    with BuildPart() as l:
        with BuildSketch(Plane.XZ):
            with BuildLine():
                Polyline((0, -w1 / 2), (length, -w2 / 2), (length, w2 / 2), (0, w1 / 2), close=True)
            make_face()
            Circle(w1 / 2)
            with Locations((length, 0)):
                Circle(w2 / 2)
            with Locations((length * 0.5, 0)):
                SlotCenterToCenter(length * 0.42, min(w1, w2) * 0.42, mode=Mode.SUBTRACT)
        extrude(amount=t / 2, both=True)
        fillet(l.edges().filter_by(Axis.Y, reverse=True), 2.2)
    part = l.part.rotate(Axis.Y, -ang).moved(Location((x1, y, z1)))
    part.label, part.color = label, SHELL
    return part

# ---- body
with BuildPart() as body:
    Box(L, W, H)
    fillet(body.edges().filter_by(Axis.X), 28)
    fillet(body.edges().filter_by(Axis.X, reverse=True), 14)
    # top deck with vent slots
    with BuildSketch(Plane.XY.offset(H / 2)):
        RectangleRounded(L * 0.55, W * 0.62, 18)
    extrude(amount=10)
    with BuildSketch(Plane.XY.offset(H / 2 + 10)):
        with GridLocations(0, 12, 1, 7):
            SlotCenterToCenter(L * 0.32, 5)
    extrude(amount=-4, mode=Mode.SUBTRACT)
    # side panels recessed
    for off in (W / 2, -W / 2):
        with BuildSketch(Plane.XZ.offset(off)):
            RectangleRounded(L * 0.62, H * 0.52, 12)
        extrude(amount=3, both=True, mode=Mode.SUBTRACT)
body_p = body.part.moved(Location((0, 0, Z0 + 18)))
body_p.label, body_p.color = "body", SHELL

# ---- head: sensor block at the front
with BuildPart() as head:
    Box(70, W * 0.72, H * 0.74)
    fillet(head.edges(), 16)
    with BuildSketch(Plane.YZ.offset(35)):
        RectangleRounded(W * 0.56, H * 0.36, 10)
    extrude(amount=-4, mode=Mode.SUBTRACT)
head_p = head.part.moved(Location((L / 2 + 35, 0, Z0 + 22)))
head_p.label, head_p.color = "head", SHELL
with BuildPart() as visor:
    with BuildSketch(Plane.YZ.offset(L / 2 + 35 + 31)):
        with Locations((0, Z0 + 22)):
            RectangleRounded(W * 0.52, H * 0.30, 8)
    extrude(amount=3)
    with BuildSketch(Plane.YZ.offset(L / 2 + 35 + 34)):
        with Locations((-26, Z0 + 22), (26, Z0 + 22)):
            Circle(9)
    extrude(amount=2)
visor_p = visor.part
visor_p.label, visor_p.color = "sensor visor", RUBBER

parts = [body_p, head_p, visor_p]
th, sh = params["thigh"], params["shin"]
a1, a2 = math.radians(params["hip_angle"]), math.radians(params["knee_angle"])
for fx, fname in ((1, "front"), (-1, "rear")):
    for sy, sname in ((1, "left"), (-1, "right")):
        hx, hy = fx * (L / 2 - 62), sy * (W / 2 + 26)
        # knees point backwards on all legs (like most quadrupeds)
        kx, kz = hx - th * math.sin(a1), Z0 - th * math.cos(a1)
        fx_, fz = kx + sh * math.sin(a2 - a1), kz - sh * math.cos(a2 - a1)
        hip = actuator(44, 46, f"{fname} {sname} hip").moved(Location((hx, hy, Z0)))
        thigh = link((hx, Z0), (kx, kz), 52, 40, 14, hy + sy * 33, f"{fname} {sname} thigh")
        knee = actuator(36, 40, f"{fname} {sname} knee").moved(Location((kx, hy + sy * 62, kz)))
        shin = link((kx, kz), (fx_, fz + 14), 36, 22, 12, hy + sy * 90, f"{fname} {sname} shin")
        foot = Sphere(19).moved(Location((fx_, hy + sy * 90, fz + 2)))
        foot.label, foot.color = f"{fname} {sname} foot", RUBBER
        parts += [hip, thigh, knee, shin, foot]

result = Compound(label="quadruped", children=parts)
'''

CONSTRAINED_PLATE = '''\
from build123d import *
from constraint_sketch import ConstraintSketch

params = {"width": 90, "height": 60, "foot": 30, "slope_angle": 135, "hole": 4, "hole_inset": 17, "thickness": 6}

# Draw roughly, then let constraints place the geometry.
sketch = ConstraintSketch()
origin = sketch.point(0, 0, fixed=True)
bottom_right = sketch.point(85, 2)
step_corner = sketch.point(88, 28)
slope_start = sketch.point(55, 31)
slope_end = sketch.point(30, 58)
top_left = sketch.point(2, 62)
bottom = sketch.line(origin, bottom_right)
right = sketch.line(bottom_right, step_corner)
shelf = sketch.line(step_corner, slope_start)
slope = sketch.line(slope_start, slope_end)
top = sketch.line(slope_end, top_left)
left = sketch.line(top_left, origin)
outline = [bottom, right, shelf, slope, top, left]
sketch.horizontal(bottom)
sketch.vertical(right)
sketch.parallel(shelf, bottom)
sketch.parallel(top, bottom)
sketch.perpendicular(left, bottom)
sketch.length(bottom, params["width"])
sketch.length(right, params["foot"])
sketch.length(left, params["height"])
sketch.angle(bottom, slope, params["slope_angle"])
sketch.equal(shelf, top)

# Three equal bolt holes, placed by construction lines.
corner_hole = sketch.circle(sketch.point(12, 12), radius=3)
foot_hole = sketch.circle(sketch.point(74, 16), radius=3)
top_hole = sketch.circle(sketch.point(13, 47), radius=3)
sketch.radius(corner_hole, params["hole"])
sketch.equal(foot_hole, corner_hole)
sketch.equal(top_hole, corner_hole)
corner_diagonal = sketch.line(origin, corner_hole.center_point)
sketch.angle(bottom, corner_diagonal, 45)
sketch.length(corner_diagonal, params["hole_inset"])
sketch.midpoint(foot_hole.center_point, sketch.line(bottom_right, slope_start))
top_diagonal = sketch.line(top_left, top_hole.center_point)
sketch.angle(left, top_diagonal, 45)
sketch.equal(top_diagonal, corner_diagonal)

solution = sketch.solve()
print("degrees of freedom left:", solution.degrees_of_freedom)
with BuildPart() as plate:
    add(solution.face(outer_loop_lines=outline))
    extrude(amount=params["thickness"])
    chamfer(plate.edges().group_by(Axis.Z)[-1].filter_by(GeomType.LINE), 1)

result = plate.part
'''

EXAMPLES = [
    {"id": "quadruped", "name": "Quadruped robot (23-part assembly)", "script": QUADRUPED},
    {"id": "bracket", "name": "Angle bracket", "script": BRACKET},
    {"id": "flange", "name": "Bearing flange", "script": FLANGE},
    {"id": "gear", "name": "Spur gear", "script": GEAR},
    {"id": "enclosure", "name": "Electronics enclosure", "script": ENCLOSURE},
    {"id": "leg", "name": "Quadruped leg (assembly)", "script": LEG},
    {"id": "constrained_plate", "name": "Constraint-sketched plate", "script": CONSTRAINED_PLATE},
]
