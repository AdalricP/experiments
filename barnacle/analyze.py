"""Does Barnacle actually work? Runs the numbers the design rests on.

    python3 analyze.py

1. Reach: how far the plate can tilt while keeping a point under the nozzle.
2. Accuracy: how far the printed spot moves for a given servo angle error.
3. Preload: do the per-arm springs keep every servo pushing the same way
   (which takes the gear backlash out), and do the magnetic joints stay seated?
4. Demo job: Braille "HOT" printed onto a domed knob, every dot standing
   normal to the surface, checked pose by pose and written out as servo
   pulses in demo_braille.csv.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from kinematics import (Geometry, Unreachable, contact_error, home, ik, leg_forces,
                        pose_for_contact, pulses_us)

HERE = Path(__file__).parent

# -- assumptions you should check against your parts --------------------------
SERVO_STALL_NM = 2.0          # ~20 kg*cm at 7.4 V, typical HV standard servo
SERVO_RESOLUTION_DEG = 0.1    # digital servo deadband ~1 us at ~11 us/deg
BACKLASH_DEG = 0.5            # cheap metal-gear servo, measured at the horn
ARM_SPRING_N = 8.0            # preload spring on each servo arm tip, pulling down
MAGNET_HOLD_N = 8.0           # pull-off force of a 10 mm ball on a 12 x 4 mm N52 cup
MOVING_MASS_KG = 0.15         # platform + PEI disc + object
NOZZLE_FORCE_N = (1.0, 0.0, 2.0)  # drag + push-back at the nozzle (x, y, -z)
PLATE_TOP = 10.0              # platform top surface, platform frame


def tilt_reach(g, h):
    """Largest tilt (deg) in each direction with platform point (0, 0, h) held at the nozzle."""
    az = np.arange(0, 360, 10)
    out = []
    for a in np.radians(az):
        best = 0.0
        for tilt in np.arange(0, 60, 0.5):
            n = [np.sin(np.radians(tilt)) * np.cos(a), np.sin(np.radians(tilt)) * np.sin(a), np.cos(np.radians(tilt))]
            try:
                ik(g, *pose_for_contact(g, np.array([0, 0, h]), np.array(n)))
                best = tilt
            except Unreachable:
                break
        out.append(best)
    return az, np.array(out)


def preload_check(g, R, t, alpha, q):
    """Each servo arm has its own extension spring pulling the arm tip down.
    That torque is reacted inside the servo, so it biases the gear train the
    same way at every pose, as long as it beats whatever the rod adds.
    Returns (weakest rod force, + = compression), worst-case spring torque margin
    (> 0 means the servo never reverses), peak servo torque."""
    from kinematics import arm_tips
    gravity = np.array([0, 0, -9.81 * MOVING_MASS_KG])
    contact = t + R @ q
    f_g, tau_g = leg_forces(g, R, t, alpha, gravity, t)
    axis = np.c_[-np.sin(g.beta), np.cos(g.beta), 0 * g.beta]
    lever = arm_tips(g, alpha) - g.b
    tau_s = np.einsum("ij,ij->i", np.cross(lever, [0, 0, -ARM_SPRING_N]), axis) / 1000
    worst_f, margin, peak = np.inf, np.inf, 0.0
    for a in np.radians(np.arange(0, 360, 45)):
        F = np.array([NOZZLE_FORCE_N[0] * np.cos(a), NOZZLE_FORCE_N[0] * np.sin(a), -NOZZLE_FORCE_N[2]])
        f_n, tau_n = leg_forces(g, R, t, alpha, F, contact)
        f = f_g + f_n
        # moments on the arm from the rod and the spring; the servo holds
        # against their sum, so that sum must never change sign
        need = tau_g + tau_n + tau_s
        worst_f = min(worst_f, f.min())
        margin = min(margin, (np.sign(tau_s) * need).min())
        peak = max(peak, np.abs(need).max())
    return worst_f, margin, peak


BRAILLE = {"H": (1, 2, 5), "O": (1, 3, 5), "T": (2, 3, 4, 5)}
DOT_PITCH, CELL_PITCH = 2.5, 6.2          # standard Braille spacing, mm
DOT_D, DOT_H, LAYER = 1.5, 0.5, 0.125     # dot diameter/height, conformal layer


def knob(radius=22.0, height=12.0):
    """Spherical cap sitting on the plate: a domed oven knob or bottle cap."""
    return np.array([0, 0, PLATE_TOP + height - radius]), radius, height


def braille_path(word="HOT"):
    """Every dot is printed as conformal layers of tiny circles, each layer
    normal to the knob's surface. Returns platform-frame points and normals."""
    centre, radius, _ = knob()
    pts, nrm = [], []
    width = (len(word) - 1) * CELL_PITCH + DOT_PITCH
    for c, ch in enumerate(word):
        for dot in BRAILLE[ch]:
            col, row = (dot - 1) // 3, (dot - 1) % 3
            u = c * CELL_PITCH + col * DOT_PITCH - width / 2      # arc length along x
            v = (1 - row) * DOT_PITCH                              # arc length along y
            n = np.array([np.sin(u / radius), np.sin(v / radius), 0])
            n[2] = np.sqrt(max(0.0, 1 - n[0] ** 2 - n[1] ** 2))
            n /= np.linalg.norm(n)
            # tangent frame at the dot
            e1 = np.cross([0, 1.0, 0], n)
            e1 /= np.linalg.norm(e1)
            e2 = np.cross(n, e1)
            for layer in range(int(round(DOT_H / LAYER))):
                h = (layer + 0.5) * LAYER
                r_dot = DOT_D / 2 * np.sqrt(max(0.05, 1 - (h / DOT_H) ** 2))  # dome-shaped dot
                for r in np.arange(r_dot - 0.2, 0, -0.4):
                    for a in np.linspace(0, 2 * np.pi, 13)[:-1]:
                        pts.append(centre + (radius + h) * n + r * (np.cos(a) * e1 + np.sin(a) * e2))
                        nrm.append(n)
    return np.array(pts), np.array(nrm)


def main():
    g = Geometry()
    print(f"geometry: base r {g.base_radius}, platform r {g.plat_radius}, arm {g.arm}, "
          f"rod {g.rod}, home height {g.home_z:.1f} mm, nozzle at z {g.nozzle[2]:.1f}")

    # 1. reach
    q_top = np.array([0, 0, g.nozzle_above_plate])
    az, reach = tilt_reach(g, g.nozzle_above_plate)
    print(f"\n[reach] tilt about the nozzle, any direction: {reach.min():.1f} deg "
          f"(best direction {reach.max():.1f} deg)")

    # 2. accuracy at home
    R0, t0 = home(g)
    e_res = contact_error(g, R0, t0, q_top, np.radians(SERVO_RESOLUTION_DEG))
    e_bl = contact_error(g, R0, t0, q_top, np.radians(BACKLASH_DEG))
    print(f"[accuracy] worst-case spot error at home: {e_res:.3f} mm from "
          f"{SERVO_RESOLUTION_DEG} deg servo resolution; {e_bl:.2f} mm if "
          f"{BACKLASH_DEG} deg backlash were left in")

    # 3+4. demo job: raise the hotend so its tip sits at the top of the knob
    centre, radius, height = knob()
    g = Geometry(nozzle_above_plate=PLATE_TOP + height)
    pts, nrm = braille_path("HOT")
    rows, errs, fmin, tmax, margins, tilts, alphas = [], [], [], [], [], [], []
    skipped = 0
    e_cum, t_job = 0.0, 0.0
    for k, (q, n) in enumerate(zip(pts, nrm)):
        try:
            R, t = pose_for_contact(g, q, n)   # dots must stand normal to the surface
            alpha = ik(g, R, t)
        except Unreachable:
            skipped += 1
            continue
        errs.append(contact_error(g, R, t, q, np.radians(SERVO_RESOLUTION_DEG)))
        f, margin, tau = preload_check(g, R, t, alpha, q)
        fmin.append(f)
        tmax.append(tau)
        margins.append(margin)
        tilts.append(np.degrees(np.arccos(R[2, 2])))
        alphas.append(np.degrees(alpha))
        if k:
            step = np.linalg.norm(pts[k] - pts[k - 1])
            if step < 1.0:   # printing inside a dot: 0.4 x 0.125 bead from 1.75 mm filament
                e_cum += step * 0.017
                t_job += 0.04
            else:            # hop to the next dot: no extrusion, give the servos time
                t_job += 0.3
        rows.append([round(t_job, 3), *pulses_us(g, alpha).round(2), round(e_cum, 4)])
    alphas = np.array(alphas)
    print(f"\n[demo] Braille 'HOT' onto a domed knob (sphere r {radius:.0f} mm), every dot normal "
          f"to the surface: {len(rows)} poses, {skipped} unreachable")
    print(f"       plate tilt used up to {max(tilts):.1f} deg")
    print(f"       servo angles {alphas.min():.1f} .. {alphas.max():.1f} deg")
    print(f"       spot error from servo resolution: median {np.median(errs):.3f}, max {max(errs):.3f} mm")
    print(f"[preload] {ARM_SPRING_N:.0f} N arm springs: smallest torque margin before a servo "
          f"reverses {1000 * min(margins):.0f} N*mm (must stay > 0)")
    print(f"          worst rod load {min(fmin):+.1f} N (negative = pulling a ball out of its cup; "
          f"magnets hold ~{MAGNET_HOLD_N:.0f} N)")
    print(f"          peak servo torque {max(tmax):.2f} N*m = {100 * max(tmax) / SERVO_STALL_NM:.0f}% of stall")

    header = "t_s,s1_us,s2_us,s3_us,s4_us,s5_us,s6_us,e_mm"
    np.savetxt(HERE / "demo_braille.csv", np.array(rows), delimiter=",", header=header, comments="", fmt="%.4f")

    # figure
    fig = plt.figure(figsize=(14, 4.6), dpi=110)
    ax = fig.add_subplot(1, 3, 1, projection="polar")
    ax.plot(np.radians(np.r_[az, az[:1]]), np.r_[reach, reach[:1]], color="#2a6fdb", lw=2)
    ax.fill(np.radians(np.r_[az, az[:1]]), np.r_[reach, reach[:1]], color="#2a6fdb", alpha=0.15)
    ax.set_title("Plate tilt reach about the nozzle (deg)", fontsize=10)
    ax.set_rlim(0, 30)
    ax = fig.add_subplot(1, 3, 2, projection="3d")
    ax.plot(*pts.T, color="#d08c3a", lw=0.8)
    ax.set_title("Demo: Braille 'HOT' printed onto a domed knob", fontsize=10)
    uu, vv = np.meshgrid(np.linspace(-0.6, 0.6, 30), np.linspace(-0.6, 0.6, 30))
    sx, sy = radius * np.sin(uu), radius * np.sin(vv)
    sz = centre[2] + np.sqrt(np.clip(radius**2 - sx**2 - sy**2, 0, None))
    ax.plot_surface(sx, sy, sz, color="#b8bec6", alpha=0.35, linewidth=0)
    ax.set_box_aspect((1, 1, 0.5))
    ax.set_xlabel("x"), ax.set_ylabel("y")
    ax = fig.add_subplot(1, 3, 3)
    for i in range(6):
        ax.plot(np.array(rows)[:, 0], alphas[:, i], lw=0.8, label=f"servo {i + 1}")
    ax.set_xlabel("time (s)"), ax.set_ylabel("arm angle (deg)")
    ax.set_title("Servo angles over the job", fontsize=10)
    ax.legend(fontsize=7, ncol=2)
    plt.tight_layout()
    out = HERE / "assets" / "analysis.png"
    plt.savefig(out)
    print(f"\nwrote {out.name} and demo_braille.csv")


if __name__ == "__main__":
    main()
