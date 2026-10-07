# Barnacle controller - MicroPython on a Raspberry Pi Pico (RP2040).
#
# The host does the kinematics (kinematics.py) and streams one line per pose:
#     P <us1> <us2> <us3> <us4> <us5> <us6> <e_mm>
# and the Pico answers "ok" once that pose has been applied. Other commands:
#     T <celsius>     set hotend target (0 = off)
#     PROBE           deploy probe (servo 8), report "probe 1/0", stow it
#     DEPLOY / STOW   move the probe without reading it
#     LIMP            stop sending servo pulses
#     ?               status line
#
# Pin map (GPIO numbers):
#   0-5  hexapod servos 1-6       6  probe servo (servo 8)
#   7    probe micro switch (to GND, internal pull-up)
#   8/9  DRV8871 IN1/IN2 for the gutted extruder servo's motor (servo 7)
#   10   hotend heater MOSFET gate  26  thermistor (100k NTC, 4.7k pull-up to 3V3)
#   20/21 I2C0 SDA/SCL -> AS5600 magnetic encoder on the extruder drive shaft
#
# Not yet run on hardware: treat it as a starting point and check pins, servo
# pulse limits and the heater safety limits before powering the hotend.

import math
import sys
import time

import select
from machine import ADC, I2C, PWM, Pin

SERVO_HZ = 250             # most digital HV servos take 200-333 Hz; drop to 50 for analogue
PULSE_MIN, PULSE_MAX = 600, 2400
PROBE_UP, PROBE_DOWN = 900, 2050

MM_PER_COUNT = (11.0 * math.pi) / 4096   # MK8 effective diameter ~11 mm, 12-bit AS5600
E_KP, E_KI = 900.0, 4000.0               # duty per mm of extrusion error

T_MAX = 260.0
HEAT_KP, HEAT_KI, HEAT_KD = 0.05, 0.002, 0.25


class Servo:
    def __init__(self, pin):
        self.pwm = PWM(Pin(pin))
        self.pwm.freq(SERVO_HZ)
        self.pwm.duty_ns(0)

    def us(self, pulse):
        pulse = min(max(pulse, PULSE_MIN), PULSE_MAX)
        self.pwm.duty_ns(int(pulse * 1000))   # RP2040 PWM resolves well under 0.1 us here

    def limp(self):
        self.pwm.duty_ns(0)


class Extruder:
    """Servo 7 with its control board removed: motor + gearbox + our encoder."""

    def __init__(self):
        self.i2c = I2C(0, sda=Pin(20), scl=Pin(21), freq=400_000)
        self.in1, self.in2 = PWM(Pin(8)), PWM(Pin(9))
        for p in (self.in1, self.in2):
            p.freq(20_000)
            p.duty_u16(0)
        self.last = self.raw()
        self.pos = 0.0        # mm of filament pushed since boot
        self.target = 0.0
        self.integral = 0.0

    def raw(self):
        b = self.i2c.readfrom_mem(0x36, 0x0C, 2)
        return ((b[0] << 8) | b[1]) & 0x0FFF

    def update(self, dt):
        r = self.raw()
        d = r - self.last
        if d > 2048:
            d -= 4096
        elif d < -2048:
            d += 4096
        self.last = r
        self.pos += d * MM_PER_COUNT
        err = self.target - self.pos
        self.integral = min(max(self.integral + err * dt, -5), 5)
        duty = int(min(max(E_KP * err + E_KI * self.integral, -1), 1) * 65535)
        self.in1.duty_u16(duty if duty > 0 else 0)
        self.in2.duty_u16(-duty if duty < 0 else 0)


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


servos = [Servo(p) for p in range(6)]
probe_servo = Servo(6)
probe_switch = Pin(7, Pin.IN, Pin.PULL_UP)
extruder = Extruder()
hotend = Hotend()
poll = select.poll()
poll.register(sys.stdin, select.POLLIN)


def background(ms):
    """Keep the extruder and heater loops running while we wait."""
    end = time.ticks_add(time.ticks_ms(), ms)
    while time.ticks_diff(end, time.ticks_ms()) > 0:
        extruder.update(0.002)
        time.sleep_ms(2)


def handle(line):
    parts = line.split()
    if not parts:
        return
    cmd = parts[0].upper()
    if cmd == "P" and len(parts) == 8:
        for s, us in zip(servos, parts[1:7]):
            s.us(float(us))
        extruder.target = float(parts[7])
        print("ok")
    elif cmd == "T":
        hotend.target = min(float(parts[1]), T_MAX - 15)
        print("ok")
    elif cmd == "PROBE":
        probe_servo.us(PROBE_DOWN)
        background(250)
        print("probe", 0 if probe_switch.value() else 1)
        probe_servo.us(PROBE_UP)
        background(200)
    elif cmd == "DEPLOY":
        probe_servo.us(PROBE_DOWN)
        print("ok")
    elif cmd == "STOW":
        probe_servo.us(PROBE_UP)
        print("ok")
    elif cmd == "LIMP":
        for s in servos + [probe_servo]:
            s.limp()
        print("ok")
    elif cmd == "?":
        print("temp %.1f target %.0f e %.3f/%.3f" % (hotend.temp(), hotend.target, extruder.pos, extruder.target))
    else:
        print("err", line)


buf = ""
last_heat = time.ticks_ms()
while True:
    extruder.update(0.002)
    now = time.ticks_ms()
    if time.ticks_diff(now, last_heat) >= 100:
        hotend.update(time.ticks_diff(now, last_heat) / 1000)
        last_heat = now
    if poll.poll(0):
        ch = sys.stdin.read(1)
        if ch in "\r\n":
            handle(buf.strip())
            buf = ""
        else:
            buf += ch
    time.sleep_ms(2)
