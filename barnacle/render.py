"""Assembly preview: python3 render.py [out.png] -> renders Barnacle at a tilted pose."""

import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

import parts
from kinematics import Geometry, arm_tips, ik, pose_for_contact


def tris(m, T=np.eye(4)):
    mesh = m.to_mesh()
    v = mesh.vert_properties[:, :3] @ T[:3, :3].T + T[:3, 3]
    return v[mesh.tri_verts]


def frame(R, t):
    T = np.eye(4)
    T[:3, :3], T[:3, 3] = R, t
    return T


def rz(deg):
    a = np.radians(deg)
    return frame(np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]]), np.zeros(3))


def scene(g, R, t, alpha):
    out = []
    pod = parts.pod(g, 0)
    for k in range(3):
        out.append((tris(pod, rz(120 * k)), "#8a9bb0"))
    for i in range(6):
        ex, ey, ez = parts.servo_frame(g, i)
        # arm rotates about the shaft; +alpha lifts the tip
        d = np.array([np.cos(g.beta[i]), np.sin(g.beta[i]), 0])
        k_ax = np.cross([0, 0, 1], d)
        a = -alpha[i]
        K = np.array([[0, -k_ax[2], k_ax[1]], [k_ax[2], 0, -k_ax[0]], [-k_ax[1], k_ax[0], 0]])
        Ra = np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K
        arm = parts.servo_arm(g, i)
        out.append((tris(arm, frame(Ra @ np.c_[ex, ey, ez], g.b[i])), "#d08c3a"))
        # servo case, as a box behind the cradle face
        case = parts.box(-parts.SERVO_W / 2, parts.SERVO_W / 2,
                         -parts.BALL_PLANE - parts.SERVO_H, -parts.BALL_PLANE,
                         parts.SERVO_SHAFT_FROM_END - parts.SERVO_L, parts.SERVO_SHAFT_FROM_END)
        out.append((tris(case, frame(np.c_[ex, ey, ez], g.b[i])), "#2b2f36"))
    out.append((tris(parts.platform(g), frame(R, t)), "#5aa469"))
    # columns + crown
    col_top = g.nozzle[2] + 55
    for k in range(3):
        c = parts.box(parts.COLUMN_R - 10, parts.COLUMN_R + 10, -10, 10, parts.FLOOR_Z + 4, col_top)
        out.append((tris(c, rz(120 * k)), "#b8bec6"))
        s = parts.box(30, parts.COLUMN_R, -10, 10, col_top - 20, col_top)
        out.append((tris(s, rz(120 * k)), "#b8bec6"))
    hotend = parts.cyl(11, g.nozzle[2] + 3, g.nozzle[2] + 14) + parts.cyl(3, g.nozzle[2], g.nozzle[2] + 3) \
        + parts.cyl(11, g.nozzle[2] + 14, col_top - 10)
    out.append((tris(hotend), "#c0392b"))
    return out


def draw(ax, g, R, t, alpha, elev, azim):
    for tri, color in scene(g, R, t, alpha):
        pc = Poly3DCollection(tri, facecolor=color, edgecolor="none", alpha=1.0)
        ax.add_collection3d(pc)
    A = arm_tips(g, alpha)
    P = (R @ g.p.T).T + t
    for a, p in zip(A, P):
        ax.plot(*np.c_[a, p], color="#222", lw=2.5)
    lim = 140
    ax.set_xlim(-lim, lim), ax.set_ylim(-lim, lim), ax.set_zlim(-60, 220)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev, azim)
    ax.set_axis_off()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "assets/assembly.png"
    g = Geometry()
    n = np.array([np.sin(np.radians(18)), 0, np.cos(np.radians(18))])
    R, t = pose_for_contact(g, np.array([0, 0, g.nozzle_above_plate]), n)
    alpha = ik(g, R, t)
    fig = plt.figure(figsize=(14, 7), dpi=110)
    for j, (e, az) in enumerate([(18, -60), (75, -90)]):
        ax = fig.add_subplot(1, 2, j + 1, projection="3d")
        draw(ax, g, R, t, alpha, e, az)
    fig.suptitle("Barnacle — platform tilted 18° to face a slope at the fixed nozzle", fontsize=13)
    plt.tight_layout()
    plt.savefig(out)
    print("wrote", out)
