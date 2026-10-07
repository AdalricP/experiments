"""Barnacle: rotary-servo Stewart platform kinematics for a fixed-nozzle printer.

The hotend never moves. Six hobby servos move the build plate in all six axes,
so the object on the plate can be tilted until the spot being printed faces the
nozzle squarely. That is what lets Barnacle print *onto* curved objects.

Frames: base frame has z up, origin in the plane of the servo shafts at the
centre of the base. Platform frame sits at the platform ball-joint plane.
All lengths in mm, angles in radians unless a name says otherwise.
"""

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Geometry:
    # Defaults come from the search in analyze.py: steep legs (big base, small
    # platform, short rods) so lateral error stays near the servo resolution.
    base_radius: float = 100.0     # servo shaft axis -> centre, in plan
    plat_radius: float = 38.0      # platform ball-joint circle
    arm: float = 20.0              # servo horn arm, shaft to ball centre
    rod: float = 80.0              # ball-to-ball rod length
    base_split_deg: float = 25.0   # half-angle between the two servos of a pair
    plat_split_deg: float = 8.0    # half-angle between two platform joints of a pair
    servo_limit_deg: float = 75.0  # usable arm swing either side of horizontal
    ball_limit_deg: float = 45.0   # magnetic ball joint cone half-angle
    nozzle_above_plate: float = 30.0  # nozzle tip above the platform joint plane, at home

    b: np.ndarray = field(init=False)      # base anchor (shaft) points, 6x3
    p: np.ndarray = field(init=False)      # platform anchor points, 6x3
    beta: np.ndarray = field(init=False)   # direction each arm swings in plan
    shaft: np.ndarray = field(init=False)  # servo shaft direction, 6x3 (bodies all sit inboard)
    sign: np.ndarray = field(init=False)   # +1 if the shaft points along +axis
    home_z: float = field(init=False)

    def __post_init__(self):
        sb, sp = np.radians(self.base_split_deg), np.radians(self.plat_split_deg)
        b, p, beta = [], [], []
        for k in range(3):
            c = np.radians(120 * k)
            for side in (+1, -1):
                tb = c + side * sb
                # each leg leans toward the neighbouring pair, so its platform
                # joint sits 60 deg round from the pair centre
                tp = c + side * (np.radians(60) - sp)
                b.append([self.base_radius * np.cos(tb), self.base_radius * np.sin(tb), 0])
                p.append([self.plat_radius * np.cos(tp), self.plat_radius * np.sin(tp), 0])
                beta.append(tb + side * np.pi / 2)
        self.b, self.p = np.array(b), np.array(p)
        self.beta = np.array(beta)
        # the arm swings about axis = z x arm-direction; mount every servo with
        # its shaft pointing outward so the bodies tuck inside the base circle
        axis = np.c_[-np.sin(self.beta), np.cos(self.beta), 0 * self.beta]
        self.sign = np.sign(np.einsum("ij,ij->i", axis, self.b))
        self.shaft = axis * self.sign[:, None]
        # home height: every arm horizontal
        a_tip = self.b + self.arm * np.c_[np.cos(self.beta), np.sin(self.beta), 0 * self.beta]
        d = np.linalg.norm((self.p - a_tip)[:, :2], axis=1)
        self.home_z = float(np.sqrt(self.rod**2 - d.max() ** 2))

    @property
    def nozzle(self):
        """Fixed nozzle tip, base frame."""
        return np.array([0.0, 0.0, self.home_z + self.nozzle_above_plate])


def rot(rx, ry, rz):
    cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def align(n):
    """Smallest rotation taking unit vector n onto +z (Rodrigues)."""
    n = n / np.linalg.norm(n)
    z = np.array([0.0, 0.0, 1.0])
    v, c = np.cross(n, z), float(n @ z)
    if np.linalg.norm(v) < 1e-12:
        return np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)


class Unreachable(ValueError):
    pass


def ik(g: Geometry, R, t, check=True):
    """Servo angles (rad, + = arm up) for platform pose (R, t) in base frame."""
    P = (R @ g.p.T).T + t
    L = P - g.b
    e = 2 * g.arm * L[:, 2]
    f = 2 * g.arm * (np.cos(g.beta) * L[:, 0] + np.sin(g.beta) * L[:, 1])
    gg = (L**2).sum(1) - (g.rod**2 - g.arm**2)
    ratio = gg / np.hypot(e, f)
    if np.any(np.abs(ratio) > 1):
        raise Unreachable("leg cannot reach")
    alpha = np.arcsin(ratio) - np.arctan2(f, e)
    if check:
        if np.any(np.abs(alpha) > np.radians(g.servo_limit_deg)):
            raise Unreachable(f"servo past limit: {np.degrees(alpha).round(1)}")
        if max(ball_angles(g, R, t, alpha)) > g.ball_limit_deg:
            raise Unreachable("ball link binds")
    return alpha


def arm_tips(g, alpha):
    ca = np.cos(alpha)
    return g.b + g.arm * np.c_[ca * np.cos(g.beta), ca * np.sin(g.beta), np.sin(alpha)]


def ball_angles(g, R, t, alpha):
    """Worst misalignment (deg) at the arm-end and platform-end ball links.

    Links are mounted so that at home the rod runs straight through both.
    """
    P = (R @ g.p.T).T + t
    u = P - arm_tips(g, alpha)
    u /= np.linalg.norm(u, axis=1, keepdims=True)
    u0 = g.p + [0, 0, g.home_z] - arm_tips(g, np.zeros(6))
    u0 /= np.linalg.norm(u0, axis=1, keepdims=True)
    # arm end: the link rotates with the arm about the shaft axis
    axis = np.c_[-np.sin(g.beta), np.cos(g.beta), 0 * g.beta]
    arm_end = []
    for i in range(6):
        a = alpha[i]
        k = axis[i]
        Ra = np.cos(a) * np.eye(3) + np.sin(a) * np.array(
            [[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]]) + (1 - np.cos(a)) * np.outer(k, k)
        # arm swings "up" for +alpha, which is a rotation of -alpha about +axis
        Ra = Ra.T
        arm_end.append(np.degrees(np.arccos(np.clip(u[i] @ (Ra @ u0[i]), -1, 1))))
    plat_end = np.degrees(np.arccos(np.clip(np.einsum("ij,ij->i", u, (R @ u0.T).T), -1, 1)))
    return max(arm_end), float(plat_end.max())


def pose_for_contact(g, q, n, yaw=0.0):
    """Pose that puts platform-frame point q under the nozzle with normal n facing up."""
    R = rot(0, 0, yaw) @ align(n)
    t = g.nozzle - R @ q
    return R, t


def home(g):
    return np.eye(3), np.array([0, 0, g.home_z])


def leg_forces(g, R, t, alpha, force, at):
    """Rod forces (N, + = compression) and servo torques (N*m) for an external
    force on the platform applied at base-frame point `at`."""
    P = (R @ g.p.T).T + t
    u = P - arm_tips(g, alpha)
    u /= np.linalg.norm(u, axis=1, keepdims=True)
    # compression f pushes the platform along +u
    A = np.vstack([u.T, np.cross(P - t, u).T])
    w = -np.concatenate([force, np.cross(at - t, force)])
    f = np.linalg.solve(A, w)
    # moment the rod puts on each arm about its swing axis (the servo holds
    # against this; a rod in compression pushes the arm along -u)
    axis = np.c_[-np.sin(g.beta), np.cos(g.beta), 0 * g.beta]
    lever = arm_tips(g, alpha) - g.b
    tau = np.einsum("ij,ij->i", np.cross(lever, -f[:, None] * u), axis)
    return f, tau / 1000.0


def contact_error(g, R, t, q, dalpha):
    """How far the printed spot moves relative to the nozzle when every servo
    is off by up to +-dalpha (rad). Worst case over all 64 sign patterns."""
    eps = 1e-6
    a0 = ik(g, R, t, check=False)
    J = np.zeros((6, 6))  # d alpha / d pose (dx dy dz, small rotations)
    for k in range(6):
        d = np.zeros(6)
        d[k] = eps
        Rk = rot(*d[3:]) @ R
        J[:, k] = (ik(g, Rk, t + d[:3], check=False) - a0) / eps
    Jinv = np.linalg.inv(J)
    worst = 0.0
    r = R @ q  # lever from platform origin to contact point
    for bits in range(64):
        s = np.array([1 if bits >> i & 1 else -1 for i in range(6)]) * dalpha
        dp = Jinv @ s
        worst = max(worst, np.linalg.norm(dp[:3] + np.cross(dp[3:], r)))
    return worst


STEPS_PER_REV = 4096   # STS3215 12-bit magnetic encoder on the output shaft


def servo_steps(g, alpha, centre=2048):
    """STS3215 goal positions (0..4095). `centre` is the reading with the arm
    level; after assembly, write each servo's offset register so that holds.
    Servos whose shaft points along -axis count the other way."""
    return np.rint(centre - g.sign * alpha * STEPS_PER_REV / (2 * np.pi)).astype(int)
