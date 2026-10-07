"""Send a pose CSV (from analyze.py or your own toolpath) to the Pico.

    pip install pyserial
    python3 stream.py /dev/ttyACM0 demo_braille.csv --temp 230
"""

import argparse
import csv
import time

import serial


def send(port, line):
    port.write((line + "\n").encode())
    while True:
        reply = port.readline().decode().strip()
        if reply:
            return reply


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device")
    ap.add_argument("csv")
    ap.add_argument("--temp", type=float, default=0, help="hotend target, 0 = dry run")
    a = ap.parse_args()
    with serial.Serial(a.device, 115200, timeout=1) as port, open(a.csv) as f:
        if a.temp:
            send(port, f"T {a.temp}")
            while float(send(port, "?").split()[1]) < a.temp - 3:
                time.sleep(1)
        rows = list(csv.DictReader(f))
        start = time.monotonic()
        for r in rows:
            wait = float(r["t_s"]) - (time.monotonic() - start)
            if wait > 0:
                time.sleep(wait)
            us = " ".join(r[f"s{i}_us"] for i in range(1, 7))
            send(port, f"P {us} {r['e_mm']}")
        send(port, "T 0")


if __name__ == "__main__":
    main()
