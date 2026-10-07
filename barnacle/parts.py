"""Printable parts for Barnacle, generated from the same Geometry the kinematics use.

    python3 parts.py            # writes stl/*.stl

Needs: pip install manifold3d trimesh numpy

Change a number in Geometry (or the hardware constants below) and every part
moves with it, so the printed machine always matches the IK.
"""

from pathlib import Path

import numpy as np
import trimesh
from manifold3d import Manifold

from kinematics import Geometry

# ---- hardware the parts are built around (measure yours, edit here) --------
SERVO_L, SERVO_W, SERVO_H = 40.5, 20.2, 38.0  # standard-size case
SERVO_SHAFT_FROM_END = 10.1   # shaft centre to the near end of the case (along L)
FLANGE_FROM_TOP = 10.5        # case top face to the flange face nearest the horn
FLANGE_HOLE_L, FLANGE_HOLE_W = 49.5, 10.0
BALL_PLANE = 16.0             # case top face to the ball-centre plane (horn + arm + cup)
EXTRUSION = 20.0              # 2020 aluminium extrusion
CLEAR = 0.3                   # fit clearance for printed pockets
FLOOR_Z = -46.0               # underside of the pods, in base frame (shaft plane = 0)
COLUMN_R = 118.0              # columns stand at the centre of each servo pair
M3, M4 = 3.4, 4.5

OUT = Path(__file__).parent / "stl"


def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def cyl(r, z0, z1, x=0.0, y=0.0, seg=48):
    return Manifold.cylinder(z1 - z0, r, circular_segments=seg).translate([x, y, z0])


def place(m, origin, ex, ey, ez):
    """Map a part built in a local (ex, ey, ez) frame into the parent frame."""
    M = np.c_[np.array([ex, ey, ez]).T, origin]
    return m.transform(M)


# ---- servo pods: one per servo pair, three per machine ----------------------
def servo_cradle():
    """Cradle in servo-local frame: x = arm swing direction (in plan),
    y = shaft axis pointing at the horn, z = up. Origin = shaft axis in the
    ball-link plane, i.e. exactly the kinematic base point b_i."""
    face = -BALL_PLANE - FLANGE_FROM_TOP          # flange seats on this y
    t = 7.0
    zc = SERVO_SHAFT_FROM_END - SERVO_L / 2        # case centre height
    w2 = SERVO_W / 2 + 8
    plate = box(-w2, w2, face - t, face, FLOOR_Z, zc + SERVO_L / 2 + 10)
    window = box(-SERVO_W / 2 - CLEAR, SERVO_W / 2 + CLEAR, face - t - 1, face + 1,
                 zc - SERVO_L / 2 - CLEAR, zc + SERVO_L / 2 + CLEAR)
    plate = plate - window
    for dz in (-FLANGE_HOLE_L / 2, FLANGE_HOLE_L / 2):
        for dx in (-FLANGE_HOLE_W / 2, FLANGE_HOLE_W / 2):
            hole = Manifold.cylinder(t + 2, M4 / 2 - 0.4, circular_segments=24)  # self-tap M4
            plate = plate - hole.rotate([90, 0, 0]).translate([dx, face + 1, zc + dz])
    # two side walls running back along the case: stiffness + keeps it square
    back = face - t - SERVO_H + FLANGE_FROM_TOP + 2
    for sx in (-1, 1):
        x0 = sx * (SERVO_W / 2 + CLEAR)
        wall = box(min(x0, x0 + sx * 5), max(x0, x0 + sx * 5), back, face - t, FLOOR_Z, zc + 6)
        plate = plate + wall
    return plate


def servo_frame(g, i):
    """(ex, ey, ez) of servo i's cradle frame: ey along the shaft, out of the horn."""
    ey = g.shaft[i]
    ez = np.array([0.0, 0.0, 1.0])
    return np.cross(ey, ez), ey, ez


def pod(g: Geometry, k=0):
    """Servo pair k (0..2) with its column socket, in base frame."""
    parts = []
    for i in (2 * k, 2 * k + 1):
        parts.append(place(servo_cradle(), g.b[i], *servo_frame(g, i)))
    # floor slab joining the pair and reaching out to the column
    c = np.radians(120 * k)
    er, et = np.array([np.cos(c), np.sin(c), 0]), np.array([-np.sin(c), np.cos(c), 0])
    span = np.abs(g.b[2 * k:2 * k + 2] @ et).max() + SERVO_W / 2 + 10
    slab = box(45, COLUMN_R + EXTRUSION / 2 + 8, -span, span, FLOOR_Z, FLOOR_Z + 6)
    sock = box(-EXTRUSION / 2 - 5, EXTRUSION / 2 + 5, -EXTRUSION / 2 - 5, EXTRUSION / 2 + 5,
               FLOOR_Z, FLOOR_Z + 40).translate([COLUMN_R, 0, 0])
    sock = sock - box(-EXTRUSION / 2 - CLEAR, EXTRUSION / 2 + CLEAR, -EXTRUSION / 2 - CLEAR,
                      EXTRUSION / 2 + CLEAR, FLOOR_Z + 4, FLOOR_Z + 41).translate([COLUMN_R, 0, 0])
    sock = sock - cyl(M4 / 2 + 0.5, FLOOR_Z - 1, FLOOR_Z + 5, x=COLUMN_R)  # bolt into extrusion core
    for z in (15, 30):  # cross screws into the extrusion T-slots
        h = Manifold.cylinder(EXTRUSION + 12, M4 / 2, circular_segments=24).rotate([90, 0, 0])
        sock = sock - h.translate([COLUMN_R, EXTRUSION / 2 + 6, FLOOR_Z + z])
    local = place(slab + sock, [0, 0, 0], er, et, [0, 0, 1])
    # screw holes to fix the pod to a plywood board
    for r, s in ((55, 0), (COLUMN_R - 25, -span + 8), (COLUMN_R - 25, span - 8)):
        p = r * er + s * et
        local = local - cyl(M4 / 2, FLOOR_Z - 1, FLOOR_Z + 7, p[0], p[1])
    body = parts[0] + parts[1] + local
    # make sure nothing intrudes into the servo pockets or horn swing
    for i in (2 * k, 2 * k + 1):
        swing = Manifold.cylinder(BALL_PLANE + 4, g.arm + 8, circular_segments=64).rotate([90, 0, 0])
        body = body - place(swing.translate([0, BALL_PLANE / 2 + 2, 0]), g.b[i], *servo_frame(g, i))
    return body


# ---- magnetic ball joints ---------------------------------------------------
# Each rod is M3 threaded rod with a 10 mm steel ball (M3-tapped) on each end, so
# its length is adjustable. Balls sit in 12 x 4 mm countersunk ring magnets.
# The preload spring keeps every rod in compression, so the balls are pushed
# into their cups at all times and the magnets are only there for safety.
MAG_D, MAG_T, BALL_SEAT = 12.0, 4.0, 2.5   # BALL_SEAT: ball centre to magnet face


def cup(origin, u, boss_r=9.0, boss_len=9.5):
    """Boss + magnet pocket for a ball at `origin`, cup opening along -u
    (u points from the ball into the part)."""
    u = np.asarray(u, float) / np.linalg.norm(u)
    ez = np.array([0.0, 0.0, 1.0])
    ex = np.cross(u, ez) if abs(u[2]) < 0.99 else np.array([1.0, 0, 0])
    ex /= np.linalg.norm(ex)
    ey = np.cross(u, ex)
    boss = place(cyl(boss_r, 1.0, boss_len), origin, ex, ey, u)
    pocket = place(cyl(MAG_D / 2 + 0.15, -12, BALL_SEAT + MAG_T), origin, ex, ey, u)
    return boss, pocket


def home_rod_dirs(g):
    """Unit vectors from arm ball to platform ball at home, base frame."""
    from kinematics import arm_tips
    u = g.p + [0, 0, g.home_z] - arm_tips(g, np.zeros(6))
    return u / np.linalg.norm(u, axis=1, keepdims=True)


# ---- moving platform --------------------------------------------------------
def platform(g: Geometry):
    """Ball centres land on g.p (z = 0, platform frame). Top surface at z = +10;
    stick a 70 mm magnetic PEI disc on it."""
    body = cyl(g.plat_radius + 2, 3, 10, seg=96)
    for k in range(3):  # pockets between the joint pairs keep the moving mass down
        a = np.radians(120 * k + 60)
        body = body - cyl(8, 2, 7, 20 * np.cos(a), 20 * np.sin(a))
    pockets = Manifold()
    for p, u in zip(g.p, home_rod_dirs(g)):
        boss, pocket = cup(p, u)
        body = body + boss
        pockets = pockets + pocket
    body = body - pockets - box(-200, 200, -200, 200, 10, 50)  # keep the top flat
    # centre eye for the preload spring hook
    eye = box(-4, 4, -8, 8, -6, 4) - Manifold.cylinder(10, 2.5, circular_segments=24).rotate([0, 90, 0]).translate([-5, 0, -2])
    return body + eye


# ---- servo arms (two mirror-image variants, three of each) -----------------
def servo_arm(g: Geometry, i):
    """Bolts to the round aluminium disc horn that comes with the servo
    (4 x M2.5 on a 14 mm circle; check yours). Built in servo i's cradle frame
    and printed flat on its back."""
    ex, ey, ez = servo_frame(g, i)
    d = np.array([np.cos(g.beta[i]), np.sin(g.beta[i]), 0])
    xdir = np.sign(d @ ex)
    u_local = np.array([home_rod_dirs(g)[i] @ ex, home_rod_dirs(g)[i] @ ey, home_rod_dirs(g)[i] @ ez])
    tip = np.array([xdir * g.arm, 0, 0])
    y0, y1 = -BALL_PLANE + 5, -5.0       # arm plate, horn face side to front
    plate = Manifold.hull(cyl(11, 0, 1).rotate([90, 0, 0]).translate([0, 0, 0])
                          + cyl(8, 0, 1).rotate([90, 0, 0]).translate([tip[0], 0, 0]))
    plate = plate.scale([1, (y1 - y0), 1]).translate([0, y1, 0])
    boss, pocket = cup(tip, -u_local)    # rod leaves the arm going up, cup opens up
    body = plate + boss
    for a in range(4):
        ang = np.radians(45 + 90 * a)
        body = body - Manifold.cylinder(30, 1.4, circular_segments=16).rotate([90, 0, 0]).translate(
            [7 * np.cos(ang), 10, 7 * np.sin(ang)])
    body = body - Manifold.cylinder(30, 4.5, circular_segments=24).rotate([90, 0, 0]).translate([0, 10, 0])
    return body - pocket


# ---- top crown: hotend hub + 2020 spokes + elbows ---------------------------
def hub():
    """Centre hub. Clamps an E3D-V6-style groove mount (12 mm neck, 16 mm collar)
    and takes three 2020 spokes out to the column elbows."""
    r = 34
    body = cyl(r, 0, 14, seg=6)  # hexagon
    for k in range(3):
        a = np.radians(120 * k)
        arm = box(r - 6, r + 26, -EXTRUSION / 2 - 5, EXTRUSION / 2 + 5, 0, 26)
        arm = arm - box(r, r + 27, -EXTRUSION / 2 - CLEAR, EXTRUSION / 2 + CLEAR, 2, 22.6)
        arm = arm - Manifold.cylinder(40, M4 / 2, circular_segments=24).translate([r + 13, 0, -5])
        body = body + arm.rotate([0, 0, np.degrees(a)])
    # V6 groove: 16 mm collar above and below, 12 mm neck, 6 mm high
    body = body - cyl(8 + CLEAR, -1, 4) - cyl(6 + CLEAR, 3.9, 10.1) - cyl(8 + CLEAR, 10, 15)
    # slot so the hotend drops in from the side, closed by the cap
    body = body - box(-6 - CLEAR, 6 + CLEAR, -40, 0, 3.9, 10.1) - box(-8 - CLEAR, 8 + CLEAR, -40, 0, -1, 4)
    for x in (-14, 14):
        body = body - cyl(M3 / 2, -1, 15, x=x, y=-18)
    # the extruder and probe servo bolt to the spokes with printed T-nut clips,
    # so they can slide to suit whichever hotend you have
    return body


def hub_cap():
    cap = box(-20, 20, -34, -10, 0, 14)
    cap = cap - cyl(8 + CLEAR, -1, 4) - cyl(6 + CLEAR, 3.9, 10.1) - cyl(8 + CLEAR, 10, 15)
    for x in (-14, 14):
        cap = cap - Manifold.cylinder(30, M3 / 2, circular_segments=24).rotate([90, 0, 0]).translate([x, -5, 7])
    return cap


def elbow():
    """Joins a vertical 2020 column to a horizontal 2020 spoke."""
    s = EXTRUSION + 10
    body = box(-s / 2, s / 2, -s / 2, s / 2, 0, 50) + box(-s / 2, 50, -s / 2, s / 2, 30, 30 + s)
    body = body - box(-EXTRUSION / 2 - CLEAR, EXTRUSION / 2 + CLEAR, -EXTRUSION / 2 - CLEAR,
                      EXTRUSION / 2 + CLEAR, -1, 30 + 5)
    body = body - box(5, 51, -EXTRUSION / 2 - CLEAR, EXTRUSION / 2 + CLEAR, 35, 35 + EXTRUSION + 2 * CLEAR)
    for z in (12, 25):
        body = body - Manifold.cylinder(s + 2, M4 / 2, circular_segments=24).rotate([0, 90, 0]).translate([-s / 2 - 1, 0, z])
    for x in (20, 40):
        body = body - cyl(M4 / 2, 29, 31 + s, x=x)
    return body


# ---- servo 8: surface probe -------------------------------------------------
def probe_arm():
    """Bolts to a servo disc horn. Carries a KW10-style micro switch (28 x 10 x 16,
    holes 22 mm apart) on its tip so the probe can swing down beside the nozzle."""
    L = 45
    arm = box(-6, 6, 0, L, 0, 5) + cyl(10, 0, 5)
    for r in (-7, 7):  # disc-horn screws
        arm = arm - cyl(1.1, -1, 6, x=r)
    arm = arm - cyl(4, -1, 6)  # horn hub clearance
    pad = box(-14, 14, L - 4, L + 4, 0, 12)
    for x in (-11, 11):
        pad = pad - Manifold.cylinder(12, 1.1, circular_segments=16).rotate([90, 0, 0]).translate([x, L + 5, 6])
    return arm + pad


# ---- servo 7: closed-loop extruder ------------------------------------------
def extruder_body():
    """The servo's control board is removed; its motor+gearbox drive a 5 mm shaft
    through `coupler`. Shaft runs in two 625 bearings, carries an MK8 drive gear,
    and has a diametric magnet on its far end read by an AS5600."""
    t = 8
    body = box(-30, 30, -18, 18, 0, t)                    # servo flange plate
    body = body - box(-SERVO_L / 2 - CLEAR, SERVO_L / 2 + CLEAR,
                      -SERVO_W / 2 - CLEAR, SERVO_W / 2 + CLEAR, -1, t + 1).translate([SERVO_L / 2 - SERVO_SHAFT_FROM_END, 0, 0])
    for dx in (-FLANGE_HOLE_L / 2, FLANGE_HOLE_L / 2):
        for dy in (-FLANGE_HOLE_W / 2, FLANGE_HOLE_W / 2):
            body = body - cyl(M4 / 2 - 0.4, -1, t + 1, dx + SERVO_L / 2 - SERVO_SHAFT_FROM_END, dy)
    # bearing tower over the shaft: 625 = 5 x 16 x 5
    tower = box(-14, 14, -14, 14, t, t + 46)
    tower = tower - cyl(2.5 + 0.6, t - 1, t + 47)
    tower = tower - cyl(8 + 0.1, t + 18, t + 23.2) - cyl(8 + 0.1, t + 40.8, t + 47)
    tower = tower - box(-15, 15, -8, 8, t + 24, t + 39)   # gear window
    tower = tower - Manifold.cylinder(40, 1.0, circular_segments=16).rotate([90, 0, 0]).translate([5.5, 20, t + 31.5])  # 1.75 filament path
    tower = tower - Manifold.cylinder(30, 2.1, circular_segments=16).rotate([90, 0, 0]).translate([5.5, 27, t + 31.5])  # PTFE / fitting
    # idler arm pivot boss (623 bearing on an M3 bolt, spring-loaded)
    tower = tower + box(10, 20, -14, 14, t, t + 46) - cyl(M3 / 2, t - 1, t + 47, x=15, y=-9)
    return body + tower


def coupler():
    """Disc-horn -> 5 mm shaft. Two M3 set screws on the shaft flat."""
    c = cyl(10, 0, 4) + cyl(6, 4, 16)
    c = c - cyl(2.5 + 0.15, 3, 17) - cyl(4, -1, 2.5)
    for r in (-7, 7):
        c = c - cyl(1.1, -1, 5, x=r)
    for a in (0, 90):
        c = c - Manifold.cylinder(8, 1.3, circular_segments=16).rotate([0, 90, 0]).translate([0, 0, 11]).rotate([0, 0, a])
    return c


def export(m: Manifold, name):
    mesh = m.to_mesh()
    tm = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=False)
    OUT.mkdir(exist_ok=True)
    tm.export(OUT / f"{name}.stl")
    return tm


def build(g=None):
    g = g or Geometry()
    parts = {
        "pod": (pod(g, 0), 3),
        "platform": (platform(g), 1),
        "arm_a": (servo_arm(g, 0), 3),
        "arm_b": (servo_arm(g, 1), 3),
        "hub": (hub(), 1),
        "hub_cap": (hub_cap(), 1),
        "elbow": (elbow(), 3),
        "probe_arm": (probe_arm(), 1),
        "extruder_body": (extruder_body(), 1),
        "coupler": (coupler(), 1),
    }
    report = []
    for name, (m, qty) in parts.items():
        tm = export(m, name)
        ext = tm.bounds[1] - tm.bounds[0]
        report.append((name, qty, tm.is_watertight, ext, tm.volume / 1000))
    return report


if __name__ == "__main__":
    for name, qty, wt, ext, vol in build():
        print(f"{name:14s} x{qty}  {ext[0]:6.1f} x {ext[1]:6.1f} x {ext[2]:6.1f} mm"
              f"  {vol:6.1f} cm3  watertight={wt}")
