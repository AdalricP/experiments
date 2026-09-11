"""Open-loop versus closed-loop hill climbing, rendered with Pygame.

Run: python3 hill_climb.py
Capture: SDL_VIDEODRIVER=dummy python3 hill_climb.py --capture assets/hill-climb-dashboard.png
"""
from __future__ import annotations

import argparse
import math
import os
from collections import deque

import pygame

WIDTH, HEIGHT = 1360, 820
ROAD_Y = 500
LEFT, RIGHT = 82, 1280
HILL_START, HILL_END = 470, 990
DT = 1 / 60

INK = (228, 236, 242)
MUTED = (152, 170, 183)
BG = (13, 20, 29)
PANEL = (24, 35, 47)
PANEL_2 = (30, 44, 58)
GRID = (55, 74, 88)
OPEN = (247, 145, 88)
CLOSED = (91, 204, 198)
ROAD = (116, 134, 145)


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


class Terrain:
    def __init__(self, steepness: float = 1.0, flat: bool = False):
        self.steepness = steepness
        self.flat = flat

    @property
    def rise(self) -> float:
        return 155 * self.steepness if not self.flat else 0

    @property
    def slope(self) -> float:
        return self.rise / (HILL_END - HILL_START)

    def y(self, x: float) -> float:
        if self.flat or x < HILL_START:
            return ROAD_Y
        if x < HILL_END:
            return ROAD_Y - self.slope * (x - HILL_START)
        return ROAD_Y - self.rise

    def angle(self, x: float) -> float:
        if self.flat or x < HILL_START or x > HILL_END:
            return 0.0
        return -math.atan(self.slope)


class Car:
    def __init__(self, name: str, color: tuple[int, int, int], closed_loop: bool):
        self.name, self.color, self.closed_loop = name, color, closed_loop
        self.reset()

    def reset(self) -> None:
        self.x = 110.0
        self.speed = 0.0
        self.integral = 0.0
        self.throttle = 0.68 if not self.closed_loop else 0.0
        self.target_speed = 4.8
        self.history = deque(maxlen=260)

    def update(self, terrain: Terrain, dt: float) -> None:
        slope_angle = -terrain.angle(self.x)
        if self.closed_loop:
            error = self.target_speed - self.speed
            self.integral = clamp(self.integral + error * dt, -3, 3)
            # PI feedback plus a small gravity compensation term.
            self.throttle = clamp(0.18 + 0.20 * error + 0.035 * self.integral + 1.05 * math.sin(slope_angle), 0, 1)
        gravity = 9.81 * math.sin(slope_angle)
        drag = 0.045 * self.speed * abs(self.speed)
        acceleration = 8.2 * self.throttle - gravity - drag
        self.speed = clamp(self.speed + acceleration * dt, 0, 8.5)
        self.x += self.speed * 23 * dt
        self.history.append(self.speed)
        if self.x > RIGHT - 40:
            self.reset()


def font(size: int, bold: bool = False) -> pygame.font.Font:
    return pygame.font.SysFont("Arial", size, bold=bold)


def text(surface: pygame.Surface, value: str, pos: tuple[int, int], size: int = 20,
         color=INK, bold: bool = False) -> None:
    surface.blit(font(size, bold).render(value, True, color), pos)


def draw_road(surface: pygame.Surface, terrain: Terrain) -> None:
    points = [(LEFT, terrain.y(LEFT))]
    for x in range(LEFT, RIGHT + 1, 4):
        points.append((x, terrain.y(x)))
    points += [(RIGHT, HEIGHT - 210), (LEFT, HEIGHT - 210)]
    pygame.draw.polygon(surface, (47, 61, 65), points)
    line = [(x, terrain.y(x)) for x in range(LEFT, RIGHT + 1, 4)]
    pygame.draw.lines(surface, ROAD, False, line, 5)
    for x in range(LEFT + 20, RIGHT, 40):
        y = terrain.y(x) - 7
        pygame.draw.line(surface, (205, 214, 214), (x, y), (x + 18, terrain.y(x + 18) - 7), 2)


def draw_car(surface: pygame.Surface, car: Car, terrain: Terrain, lane: int) -> None:
    road_y = terrain.y(car.x)
    angle = terrain.angle(car.x)
    car_surface = pygame.Surface((74, 36), pygame.SRCALPHA)
    pygame.draw.rect(car_surface, car.color, (5, 12, 62, 18), border_radius=6)
    pygame.draw.polygon(car_surface, car.color, [(19, 12), (31, 2), (53, 2), (63, 12)])
    pygame.draw.circle(car_surface, BG, (20, 30), 7)
    pygame.draw.circle(car_surface, BG, (55, 30), 7)
    rotated = pygame.transform.rotozoom(car_surface, math.degrees(angle), 1)
    rect = rotated.get_rect(center=(car.x, road_y - 22 - lane * 44))
    surface.blit(rotated, rect)
    text(surface, car.name, (int(car.x) - 35, int(road_y - 72 - lane * 44)), 15, car.color, True)


def draw_history(surface: pygame.Surface, cars: list[Car]) -> None:
    rect = pygame.Rect(82, 615, 760, 158)
    pygame.draw.rect(surface, PANEL, rect, border_radius=10)
    text(surface, "Speed history", (rect.x + 18, rect.y + 13), 18, INK, True)
    for n in range(1, 4):
        y = rect.y + 42 + n * 27
        pygame.draw.line(surface, GRID, (rect.x + 14, y), (rect.right - 14, y), 1)
    for car in cars:
        if len(car.history) < 2:
            continue
        pts = []
        for i, speed in enumerate(car.history):
            x = rect.x + 16 + (rect.width - 32) * i / max(1, len(car.history) - 1)
            y = rect.bottom - 16 - (speed / 8.5) * 102
            pts.append((x, y))
        pygame.draw.lines(surface, car.color, False, pts, 3)
    text(surface, "0", (rect.x + 18, rect.bottom - 30), 13, MUTED)
    text(surface, "8.5 m/s", (rect.x + 18, rect.y + 37), 13, MUTED)


def draw_panel(surface: pygame.Surface, terrain: Terrain, open_car: Car, closed_car: Car) -> None:
    rect = pygame.Rect(870, 615, 410, 158)
    pygame.draw.rect(surface, PANEL, rect, border_radius=10)
    text(surface, "Live comparison", (rect.x + 18, rect.y + 13), 18, INK, True)
    rows = [
        ("Terrain", "flat" if terrain.flat else f"hill · {terrain.steepness:.1f}×"),
        ("Open loop", f"{open_car.speed:.2f} m/s · {open_car.throttle * 100:.0f}% input"),
        ("Closed loop", f"{closed_car.speed:.2f} m/s · {closed_car.throttle * 100:.0f}% input"),
        ("Closed target", f"{closed_car.target_speed:.1f} m/s"),
    ]
    for i, (label, value) in enumerate(rows):
        y = rect.y + 44 + i * 26
        text(surface, label, (rect.x + 18, y), 15, MUTED)
        text(surface, value, (rect.x + 150, y), 15, OPEN if i == 1 else CLOSED if i in (2, 3) else INK, i in (1, 2))


def render(surface: pygame.Surface, terrain: Terrain, open_car: Car, closed_car: Car) -> None:
    surface.fill(BG)
    text(surface, "Hill climb: open-loop vs closed-loop control", (82, 42), 32, INK, True)
    text(surface, "Same car, same hill. One holds a fixed input; the other adjusts input to hold speed.", (82, 84), 18, MUTED)
    draw_road(surface, terrain)
    text(surface, "flat", (145, ROAD_Y + 25), 16, MUTED)
    text(surface, "_ /", (HILL_START - 4, terrain.y(HILL_START) - 50), 22, INK, True)
    draw_car(surface, open_car, terrain, 0)
    draw_car(surface, closed_car, terrain, 1)
    draw_history(surface, [open_car, closed_car])
    draw_panel(surface, terrain, open_car, closed_car)
    text(surface, "W / S: open-loop input    ↑ / ↓: closed-loop target speed    [ / ]: hill steepness    F: flat / hill    R: reset", (82, 788), 15, MUTED)


def run(capture: str | None) -> None:
    pygame.init()
    surface = pygame.display.set_mode((WIDTH, HEIGHT))
    pygame.display.set_caption("Hill climb control experiment")
    clock = pygame.time.Clock()
    terrain = Terrain()
    open_car = Car("OPEN LOOP", OPEN, False)
    closed_car = Car("CLOSED LOOP", CLOSED, True)
    cars = [open_car, closed_car]
    frames, running = 0, True
    while running:
        dt = min(clock.tick(60) / 1000, 0.05)
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_w: open_car.throttle = clamp(open_car.throttle + .05, 0, 1)
                if event.key == pygame.K_s: open_car.throttle = clamp(open_car.throttle - .05, 0, 1)
                if event.key == pygame.K_UP: closed_car.target_speed = clamp(closed_car.target_speed + .4, 1, 8)
                if event.key == pygame.K_DOWN: closed_car.target_speed = clamp(closed_car.target_speed - .4, 1, 8)
                if event.key == pygame.K_RIGHTBRACKET: terrain.steepness = clamp(terrain.steepness + .2, .2, 2.2)
                if event.key == pygame.K_LEFTBRACKET: terrain.steepness = clamp(terrain.steepness - .2, .2, 2.2)
                if event.key == pygame.K_f: terrain.flat = not terrain.flat
                if event.key == pygame.K_r:
                    for car in cars: car.reset()
        # The capture moves to a steeper hill so the regulation difference is visible.
        if capture and frames == 145:
            terrain.steepness = 1.7
        for car in cars:
            car.update(terrain, DT if capture else dt)
        render(surface, terrain, open_car, closed_car)
        pygame.display.flip()
        frames += 1
        if capture and frames >= 330:
            os.makedirs(os.path.dirname(capture) or ".", exist_ok=True)
            pygame.image.save(surface, capture)
            running = False
    pygame.quit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", metavar="PATH")
    run(parser.parse_args().capture)
