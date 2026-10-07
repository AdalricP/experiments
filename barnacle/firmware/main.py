# Barnacle controller - MicroPython on a Raspberry Pi Pico (RP2040).
#
# All eight servos are Feetech STS3215 bus servos on one half-duplex TTL bus,
# IDs 1-6 = hexapod legs, 7 = extruder (wheel mode), 8 = probe arm.
#
# The host does the kinematics (kinematics.py) and streams one line per pose:
#     P <s1> <s2> <s3> <s4> <s5> <s6> <e_mm>     goal positions in encoder counts
# and the Pico answers "ok" once the goals are sent. Other commands:
#     T <celsius>     set hotend target (0 = off)
#     CHECK           read legs 1-6 back, report worst |goal - actual| in counts
#     PROBE           lower the probe arm until it feels the surface, report the
#                     encoder count where it stopped ("probe <count>"), lift it
#     LIMP            torque off on every servo
#     ?               status line
#
# Wiring (GPIO numbers):
#   0/1  UART0 TX/RX -> Waveshare Bus Servo Adapter (A) in UART mode, or a
#        74HC126 half-duplex buffer (TX and RX joined onto the servo data line)
#   10   hotend heater MOSFET gate    26  thermistor (100k NTC, 4.7k pull-up to 3V3)
#   Servo power: 7.4 V (2S) straight to the bus; Pico GND joined to it.
#
# Not yet run on hardware: check the register map against your servos' firmware
# and the heater limits before powering the hotend. Give each servo its ID once
# with Feetech's FD tool (or `set_id` below) before chaining them.

import math
import select
import sys
import time

from machine import ADC, PWM, UART, Pin

# ---- STS register map (SMS/STS series) -------------------------------------
ID_REG, MODE, TORQUE_ENABLE, ACC, GOAL_POS, GOAL_SPEED = 5, 33, 40, 41, 42, 46
TORQUE_LIMIT, LOCK, PRESENT_POS, PRESENT_LOAD = 48, 55, 56, 60
READ, WRITE, SYNC_WRITE = 0x02, 0x03, 0x83

LEGS = (1, 2, 3, 4, 5, 6)
EXTRUDER, PROBE = 7, 8
LEG_SPEED = 3400        # counts/s cap; the host paces the moves
PROBE_UP, PROBE_DOWN = 2048, 2048 + 900
PROBE_LOAD = 120        # 0..1000 (0.1 % of max torque) that counts as contact

MM_PER_COUNT = (11.0 * math.pi) / 4096   # MK8 effective diameter ~11 mm, direct on the horn
E_KP, E_KI, E_MAX = 4000.0, 8000.0, 2400  # wheel speed per mm of error, cap

T_MAX = 260.0
HEAT_KP, HEAT_KI, HEAT_KD = 0.05, 0.002, 0.25

uart = UART(0, baudrate=1_000_000, tx=Pin(0), rx=Pin(1), timeout=3)


# ---- bus protocol -----------------------------------------------------------
def packet(sid, instr, params=b""):
    body = bytes([sid, len(params) + 2, instr]) + bytes(params)
    return b"\xff\xff" + body + bytes([(~sum(body)) & 0xFF])


def transact(pkt, reply_len):
    """Send a packet; return the reply's parameter bytes (or None).
    Half-duplex wiring often echoes what we sent, so skip it if present."""
    while uart.any():
        uart.read()
    uart.write(pkt)
    uart.flush()
    if reply_len is None:
        return None
    want = len(pkt) + 6 + reply_len
    buf = b""
    end = time.ticks_add(time.ticks_ms(), 5)
    while time.ticks_diff(end, time.ticks_ms()) > 0 and len(buf) < want:
        chunk = uart.read()
        if chunk:
            buf += chunk
    if buf.startswith(pkt):
        buf = buf[len(pkt):]
    i = buf.find(b"\xff\xff")
    if i < 0 or len(buf) < i + 6 + reply_len:
        return None
    r = buf[i:i + 6 + reply_len]
    if (~sum(r[2:-1])) & 0xFF != r[-1]:
        return None
    return r[5:5 + reply_len]


def write(sid, addr, data):
    transact(packet(sid, WRITE, bytes([addr]) + bytes(data)), None)


def read_u16(sid, addr):
    d = transact(packet(sid, READ, bytes([addr, 2])), 2)
    return None if d is None else d[0] | (d[1] << 8)


def sync_write(addr, rows):
    """rows: list of (id, bytes) all the same length."""
    n = len(rows[0][1])
    params = bytes([addr, n])
    for sid, data in rows:
        params += bytes([sid]) + bytes(data)
    transact(packet(0xFE, SYNC_WRITE, params), None)


def u16(v):
    return bytes([v & 0xFF, (v >> 8) & 0xFF])


def signed15(v):
    """STS encodes negatives with bit 15 as the sign."""
    return u16((-v) | 0x8000) if v < 0 else u16(v)


def eeprom(sid, addr, value):
    write(sid, LOCK, [0])
    write(sid, addr, [value])
    write(sid, LOCK, [1])


def set_id(old, new):
    eeprom(old, ID_REG, new)


# ---- servos -----------------------------------------------------------------
goals = {}


def legs_to(counts):
    rows = []
    for sid, c in zip(LEGS, counts):
        c = min(max(int(c), 0), 4095)
        goals[sid] = c
        rows.append((sid, bytes([0]) + u16(c) + u16(0) + u16(LEG_SPEED)))  # acc, pos, time, speed
    sync_write(ACC, rows)


def worst_leg_error():
    worst = 0
    for sid in LEGS:
        p = read_u16(sid, PRESENT_POS)
        if p is None:
            return -1
        worst = max(worst, abs(p - goals.get(sid, p)))
    return worst


class Extruder:
    """Servo 7 in wheel mode. Its own encoder is unwrapped into a filament length
    and a PI loop sets the wheel speed to follow the host's e_mm."""

    def __init__(self):
        eeprom(EXTRUDER, MODE, 1)
        write(EXTRUDER, TORQUE_ENABLE, [1])
        self.last = read_u16(EXTRUDER, PRESENT_POS) or 0
        self.pos = 0.0
        self.target = 0.0
        self.integral = 0.0

    def update(self, dt):
        r = read_u16(EXTRUDER, PRESENT_POS)
        if r is None:
            return
        d = r - self.last
        if d > 2048:
            d -= 4096
        elif d < -2048:
            d += 4096
        self.last = r
        self.pos += d * MM_PER_COUNT
        err = self.target - self.pos
        self.integral = min(max(self.integral + err * dt, -0.2), 0.2)
        speed = int(min(max(E_KP * err + E_KI * self.integral, -E_MAX), E_MAX))
        write(EXTRUDER, GOAL_SPEED, signed15(speed))


def probe():
    """Sweep the probe arm down gently; the servo's load reading is the switch."""
    write(PROBE, TORQUE_LIMIT, u16(300))           # 30 % torque: it can't hurt anything
    hit = None
    for c in range(PROBE_UP, PROBE_DOWN, 4):
        write(PROBE, ACC, bytes([0]) + u16(c) + u16(0) + u16(800))
        time.sleep_ms(6)
        load = read_u16(PROBE, PRESENT_LOAD)
        if load is not None and (load & 0x3FF) > PROBE_LOAD:
            hit = read_u16(PROBE, PRESENT_POS)
            break
    write(PROBE, ACC, bytes([0]) + u16(PROBE_UP) + u16(0) + u16(1500))
    write(PROBE, TORQUE_LIMIT, u16(1000))
    return hit


class Hotend:
    def __init__(self):
        self.adc = ADC(26)
        self.heater = PWM(Pin(10))
        self.heater.freq(10)
        self.heater.duty_u16(0)
        self.target = 0.0
        self.i = 0.0
        self.prev = None

    def temp(self):
        v = self.adc.read_u16() / 65535
        if v <= 0.001 or v >= 0.999:
            return -1.0          # open or shorted thermistor
        r = 4700 * v / (1 - v)
        return 1 / (1 / 298.15 + math.log(r / 100_000) / 3950) - 273.15

    def update(self, dt):
        t = self.temp()
        if t < 0 or t > T_MAX or self.target <= 0:
            self.heater.duty_u16(0)
            self.i = 0.0
            return t
        e = self.target - t
        self.i = min(max(self.i + e * dt * HEAT_KI, 0), 0.6)
        d = 0 if self.prev is None else (t - self.prev) / dt
        self.prev = t
        out = min(max(HEAT_KP * e + self.i - HEAT_KD * d, 0), 1)
        self.heater.duty_u16(int(out * 65535))
        return t


# ---- main loop --------------------------------------------------------------
for sid in LEGS + (PROBE,):
    write(sid, TORQUE_ENABLE, [1])
extruder = Extruder()
hotend = Hotend()
poll = select.poll()
poll.register(sys.stdin, select.POLLIN)


def handle(line):
    parts = line.split()
    if not parts:
        return
    cmd = parts[0].upper()
    if cmd == "P" and len(parts) == 8:
        legs_to([int(float(x)) for x in parts[1:7]])
        extruder.target = float(parts[7])
        print("ok")
    elif cmd == "T":
        hotend.target = min(float(parts[1]), T_MAX - 15)
        print("ok")
    elif cmd == "CHECK":
        print("err_counts", worst_leg_error())
    elif cmd == "PROBE":
        print("probe", probe())
    elif cmd == "LIMP":
        for sid in LEGS + (EXTRUDER, PROBE):
            write(sid, TORQUE_ENABLE, [0])
        print("ok")
    elif cmd == "?":
        print("temp %.1f target %.0f e %.3f/%.3f" % (hotend.temp(), hotend.target, extruder.pos, extruder.target))
    else:
        print("err", line)


buf = ""
last_heat = last_e = time.ticks_ms()
while True:
    now = time.ticks_ms()
    if time.ticks_diff(now, last_e) >= 5:
        extruder.update(time.ticks_diff(now, last_e) / 1000)
        last_e = now
    if time.ticks_diff(now, last_heat) >= 100:
        hotend.update(time.ticks_diff(now, last_heat) / 1000)
        last_heat = now
    while poll.poll(0):
        ch = sys.stdin.read(1)
        if ch in "\r\n":
            handle(buf.strip())
            buf = ""
        else:
            buf += ch
