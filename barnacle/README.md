# Barnacle: a servo hexapod printer that prints *onto* things

Normal printers only print onto a flat bed. Barnacle prints onto objects you
already have, like a domed oven knob, a keycap, a pill-bottle cap or a TV
remote button. The specific problem it solves is **adding tactile Braille
labels and bumps to curved everyday controls**, so every dot stands
perpendicular to the surface it sits on.

The hotend never moves. Six of the eight Feetech **STS3215** (7.4 V) bus
servos form a Stewart platform (hexapod) under the build plate. They tilt and shift the object in all six
axes until the spot being printed faces straight up into the nozzle.

![Assembly](assets/assembly.png)

## What each servo does

| # | Job | Notes |
|---|-----|-------|
| 1–6 | Hexapod legs | Magnetic ball joints, adjustable rods, spring-preloaded arms. Positions read back after each move (`CHECK`) |
| 7 | Extruder | Unmodified, in continuous (wheel) mode. Its own 12-bit encoder measures the filament fed (about 0.008 mm per count) and the Pico closes the loop |
| 8 | Surface probe | Lowers a stylus beside the nozzle at 30% torque. Its load reading acts as the touch switch, and its encoder count at contact gives the surface height |

The STS3215 makes this much easier than PWM hobby servos would. The encoder
sits on the output shaft, so position is controlled to 1/4096 of a turn. All
eight servos share one 1 Mbps serial bus, and each can report position, load,
voltage and temperature.

## Why it is shaped this way (the numbers)

Everything below comes from `python3 analyze.py`, which uses the same
`Geometry` that generates the STLs.

* **Servo resolution is still coarse, so the geometry has to make up for it.**
  The STS3215 resolves 0.088° (one encoder count). On a typical hexapod with
  long, upright legs that becomes about 0.5 mm of lateral error. A search over the geometry
  settled on a big base (r = 100), a small platform (r = 38), short 80 mm rods
  and 20 mm arms. With those steep legs, one count of servo error moves the printed
  spot by **0.034 mm at home and at most 0.093 mm over the demo job**.
* **Backlash is the real enemy, so it is preloaded out.** The encoder sees the
  output shaft, but a servo that keeps reversing load will still hunt inside
  its gear slop. If 0.5° of that were left in, the error would be 0.19 mm. Each servo arm therefore has its
  own 8 N extension spring pulling down, so every gear train stays loaded the
  same way. The analysis checks every pose of the demo: the spring always beats
  the rod load, with at least 67 N·mm of margin.
  *I tried one central spring first. It failed: at tilted poses some rods went
  into tension and the servos reversed direction.*
* **Magnetic ball joints** (10 mm steel balls in 12×4 mm countersunk N52
  magnets) allow 45° of swing. M3 ball links bind at about 30°, which capped
  the tilt at 19°. The worst rod pull in the demo is 4 N, inside the ~8 N the
  magnets hold.
* **Servo load is light.** Peak torque is 0.19 N·m, about 10% of stall for a
  19.5 kg·cm STS3215, so the servos run cool and are not fighting for position.
* **The honest trade-off is a small workspace.** The plate can tilt at least
  18.5° in every direction (24° in the best direction) about the nozzle, but
  it can only shift about ±8.5 mm sideways. That suits Braille labels (a
  three-letter word is about 15 mm wide). It does not suit printing a vase.

![Analysis](assets/analysis.png)

The demo job prints Braille "HOT" onto a knob shaped like a sphere of radius
22 mm. Each dot is a 1.5 mm dome made of four conformal layers. It has 720
poses and all of them are reachable, using up to 20.5° of tilt. The result is
`demo_braille.csv` (time, six servo goal positions in encoder counts, and
extruder mm), which
`stream.py` sends to the controller.

## Files

| File | What it is |
|------|------------|
| `kinematics.py` | Geometry, inverse kinematics, ball-joint limits, error and statics models |
| `analyze.py` | Reach, accuracy, preload and demo-job checks; writes `assets/analysis.png` and `demo_braille.csv` |
| `parts.py` | Generates every printed part as STL from the same geometry (`stl/`) |
| `render.py` | Assembly preview |
| `firmware/main.py` | MicroPython for a Raspberry Pi Pico: STS bus protocol (sync write, reads), position check, encoder-closed extruder loop, load-sensing probe, hotend PID with thermistor-fault cutoff |
| `stream.py` | Streams a pose CSV to the Pico over USB serial |

```
pip install numpy manifold3d trimesh matplotlib
python3 analyze.py      # check the design
python3 parts.py        # regenerate STLs after changing any dimension
```

## Printed parts (PETG or ASA, 4 walls, 40% gyroid)

| Part | Qty | Notes |
|------|-----|-------|
| `pod` | 3 | Holds a servo pair in close-fitting sleeves (4 × M3 grub screws each) and the foot of a column. About 102 × 129 mm |
| `arm_a`, `arm_b` | 3 + 3 | Mirror pair; bolt to the servo's disc horn |
| `platform` | 1 | Six magnet cups; 70 mm magnetic PEI disc on top |
| `hub`, `hub_cap` | 1 + 1 | Clamp a V6-style groove mount at the centre of the crown |
| `elbow` | 3 | Join the 2020 columns to the 2020 spokes; slide them to set nozzle height |
| `extruder_body`, `coupler` | 1 + 1 | Servo 7 sleeve with a bearing tower: horn to a 5 mm shaft on two 625 bearings |
| `probe_arm` | 1 | Servo 8 horn to a stylus (optional KW10 switch pad) |

## Other hardware

* 8 × Feetech STS3215 (7.4 V), with their disc horns
* 12 × 10 mm steel balls tapped M3, 12 × 12×4 mm countersunk N52 ring magnets, 6 × M3 threaded rod about 60 mm long (sets the 80 mm ball-to-ball length)
* 6 × light extension springs (~8 N at working length) from each arm tip down to a screw in the board
* 3 × 2020 extrusion about 200 mm (columns), 3 × about 90 mm (spokes), M4 screws and T-nuts, a 300 mm plywood board
* V6-style hotend (24 V), MK8 drive gear, 5 mm shaft, 2 × 625 and 1 × 623 bearings
* Raspberry Pi Pico, a Waveshare Bus Servo Adapter (A) or a 74HC126 for the half-duplex bus, MOSFET module for the heater, 100 k NTC thermistor with a 4.7 k pull-up resistor
* Power: a regulated **7.4 V, 10 A** supply for the servos (a fully charged 2S LiPo reaches 8.4 V, which is above this servo's 7.4 V rating), and a 24 V supply for the hotend, with their grounds joined

## Assembly and calibration

1. Give each servo its ID (1–6 legs, 7 extruder, 8 probe) one at a time,
   using Feetech's FD tool or `set_id()` in the firmware. Then chain them.
2. Command every leg to count 2048, fit the horns and arms as close to
   horizontal as the spline allows, and write each servo's offset so that a
   level arm reads exactly 2048. Check which way each one counts against
   `servo_steps`.
3. Set every rod to exactly 80.0 mm ball centre to ball centre. They have to
   match, so use calipers.
4. Hook up the arm springs and check that the backlash is gone. Rock the plate
   by hand: it should feel springy, not clunky. `CHECK` after a move should
   read 0–2 counts.
5. Slide the crown so the nozzle tip sits at the top of the object, and set
   `nozzle_above_plate` to match.
6. Probe the object (`PROBE` at a grid of poses) and fit its surface. Then
   generate dots onto *that* surface rather than an ideal one.

## Known gaps and next steps

* The firmware and the parts have not been run or printed yet. This is a
  design that checks out on paper and in CAD, not a proven machine.
* The STS3215 case size (45.2 × 24.7 × 35 mm) is from the spec sheet, but the
  shaft position along the case and the horn screw circle are my estimates.
  Measure yours and edit the constants at the top of `parts.py`.
* The register addresses are the standard STS/SMS map used by Feetech's SDK.
  Confirm them against your servos with a read before trusting the probe or
  the extruder loop.
* Printed plastic needs to stick to the object. PETG sticks well to ABS/PC
  keycaps and knobs that have been lightly sanded. Glass and metal need a
  primer.
* The analysis checks collisions only between the arms and the pods. A check
  between the heater block and the tilted plate is the next thing to add.
* A small turntable on the plate would remove the ±8.5 mm limit for round
  objects, but it would need a ninth servo.
