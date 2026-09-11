"""A small log of pole-balancing ideas. Run with: python3 app.py"""
from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass, field
from typing import Type

import numpy as np
import pygame

from cartpole import CartPole
from controllers import Controller, LQRController, PIDController, QLearningController, RandomController
from rl import PPOAgent, ReinforceAgent, ShieldedRLAgent


WIDTH, HEIGHT = 1360, 820
BG, SURFACE, SURFACE_2 = (15, 22, 30), (24, 36, 48), (19, 29, 39)
INK, MUTED, GRID, FAIL = (226, 237, 241), (145, 166, 180), (56, 76, 91), (243, 101, 88)
ACCENTS = [(98, 196, 190), (247, 190, 70), (152, 127, 253), (234, 121, 163), (100, 178, 253), (111, 211, 123), (255, 151, 80)]


@dataclass
class Experiment:
    name: str
    subtitle: str
    controller_type: Type[Controller]
    color: tuple[int, int, int]
    seed: int
    env: CartPole = field(init=False)
    controller: Controller = field(init=False)
    state: np.ndarray = field(init=False)
    episode: int = 1
    episode_steps: int = 0
    best: int = 0
    history: deque = field(default_factory=lambda: deque(maxlen=100))
    recent: deque = field(default_factory=lambda: deque(maxlen=20))
    loss_history: deque = field(default_factory=lambda: deque(maxlen=100))
    sample_steps: int = 0
    flashes: int = 0

    def __post_init__(self):
        self.env = CartPole(self.seed)
        seeded = self.controller_type in (RandomController, QLearningController)
        self.controller = self.controller_type(seed=self.seed) if seeded else self.controller_type()
        self.state = self.env.state.copy()

    def tick(self):
        prior = self.state
        force = self.controller.act(prior)
        self.state, reward, done = self.env.step(force)
        self.controller.learn(prior, reward, self.state, done)
        self.episode_steps += 1
        self.sample_steps += 1
        if self.sample_steps % 8 == 0 and self.controller.loss is not None:
            self.loss_history.append(float(self.controller.loss))
        if done:
            self.history.append(self.episode_steps)
            self.recent.append(self.episode_steps)
            self.best = max(self.best, self.episode_steps)
            self.controller.episode_end()
            if self.controller.loss is not None:
                self.loss_history.append(float(self.controller.loss))
            self.state = self.env.reset()
            self.episode += 1
            self.episode_steps = 0
            self.flashes = 10

    @property
    def average(self):
        return float(np.mean(self.recent)) if self.recent else 0.0


def text(surface, font, value, pos, color=INK, anchor="topleft"):
    image = font.render(value, True, color)
    surface.blit(image, image.get_rect(**{anchor: pos}))


def draw_cartpole(surface, rect, state, color, failed):
    x, _, theta, _ = state
    rail_y = rect.bottom - 48
    cx = rect.centerx + int((x / CartPole.X_LIMIT) * rect.width * 0.39)
    pygame.draw.line(surface, GRID, (rect.left + 24, rail_y), (rect.right - 24, rail_y), 2)
    cart = pygame.Rect(cx - 34, rail_y - 12, 68, 19)
    pygame.draw.rect(surface, FAIL if failed else color, cart, border_radius=4)
    for offset in (-21, 21):
        pygame.draw.circle(surface, INK, (cx + offset, rail_y + 10), 5)
    length = min(rect.height * .58, 195)
    tip = (int(cx + np.sin(theta) * length), int(rail_y - 12 - np.cos(theta) * length))
    pygame.draw.line(surface, INK, (cx, rail_y - 12), tip, 9)
    pygame.draw.circle(surface, color, tip, 12)


def draw_plot(surface, rect, values, color, label, fonts, fixed=False, max_value=None):
    _, body, small, _ = fonts
    pygame.draw.rect(surface, SURFACE, rect, border_radius=8)
    text(surface, body, label, (rect.left + 16, rect.top + 13))
    inner = pygame.Rect(rect.left + 16, rect.top + 43, rect.width - 32, rect.height - 59)
    for fraction in (.25, .5, .75):
        y = inner.bottom - int(inner.height * fraction)
        pygame.draw.line(surface, GRID, (inner.left, y), (inner.right, y), 1)
    if fixed:
        text(surface, small, "No learning loss for this fixed controller", inner.center, MUTED, "center")
        return
    if len(values) < 2:
        text(surface, small, "Waiting for data…", inner.center, MUTED, "center")
        return
    ceiling = max_value if max_value is not None else max(max(values), 1e-5)
    points = []
    for index, value in enumerate(values):
        px = inner.left + index * inner.width / (len(values) - 1)
        py = inner.bottom - int(np.clip(value / ceiling, 0, 1) * inner.height)
        points.append((px, py))
    pygame.draw.lines(surface, color, False, points, 2)
    text(surface, small, "1,000" if max_value else f"{ceiling:.3g}", (inner.right, inner.top), MUTED, "topright")


def draw_selector(surface, rect, experiments, selected, fonts):
    _, body, small, _ = fonts
    pygame.draw.rect(surface, SURFACE, rect, border_radius=8)
    text(surface, body, "Controllers", (rect.left + 16, rect.top + 14))
    row_h, top = 45, rect.top + 49
    for i, exp in enumerate(experiments):
        row = pygame.Rect(rect.left + 8, top + i * row_h, rect.width - 16, row_h - 3)
        if i == selected:
            pygame.draw.rect(surface, SURFACE_2, row, border_radius=5)
            pygame.draw.rect(surface, exp.color, row, width=2, border_radius=5)
        pygame.draw.circle(surface, exp.color, (row.left + 15, row.centery), 5)
        text(surface, body, exp.name, (row.left + 28, row.centery), INK, "midleft")
        text(surface, small, f"avg {exp.average:5.1f}", (row.right - 10, row.centery), MUTED, "midright")


def main():
    parser = argparse.ArgumentParser(description="Run the pole-balancing experiment dashboard.")
    parser.add_argument("--screenshot", metavar="PATH", help="save one dashboard frame to PATH and exit")
    parser.add_argument("--warmup", type=int, default=0, help="simulation steps before saving a screenshot")
    args = parser.parse_args()
    pygame.init()
    pygame.display.set_caption("Pole-balancing experiments")
    screen = pygame.display.set_mode((WIDTH, HEIGHT), pygame.RESIZABLE)
    clock = pygame.time.Clock()
    fonts = (pygame.font.SysFont("Avenir Next", 25, bold=True), pygame.font.SysFont("Avenir Next", 17, bold=True), pygame.font.SysFont("Avenir Next", 13), pygame.font.SysFont("Menlo", 12))
    specs = [
        ("Random", "No model · baseline", RandomController), ("PID", "Hand-tuned feedback", PIDController),
        ("LQR", "Linear optimal control", LQRController), ("Q-learning", "Tabular RL · learns online", QLearningController),
        ("REINFORCE", "Neural policy gradient", ReinforceAgent), ("PPO", "Neural actor + critic", PPOAgent),
        ("RL → LQR shield", "RL proposal, safety fallback", ShieldedRLAgent),
    ]
    experiments = [Experiment(name, subtitle, cls, ACCENTS[i], 100 + i) for i, (name, subtitle, cls) in enumerate(specs)]
    paused, steps_per_frame, selected, running = False, 4, 3, True

    for _ in range(max(0, args.warmup)):
        for exp in experiments:
            exp.tick()

    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_SPACE:
                    paused = not paused
                elif event.key == pygame.K_r:
                    experiments = [Experiment(name, subtitle, cls, ACCENTS[i], 100 + i) for i, (name, subtitle, cls) in enumerate(specs)]
                elif event.key in (pygame.K_LEFT, pygame.K_UP):
                    selected = (selected - 1) % len(experiments)
                elif event.key in (pygame.K_RIGHT, pygame.K_DOWN):
                    selected = (selected + 1) % len(experiments)
                elif event.key in (pygame.K_EQUALS, pygame.K_PLUS):
                    steps_per_frame = min(64, steps_per_frame * 2)
                elif event.key == pygame.K_MINUS:
                    steps_per_frame = max(1, steps_per_frame // 2)
        if not paused:
            for _ in range(steps_per_frame):
                for exp in experiments:
                    exp.tick()
                    exp.flashes = max(0, exp.flashes - 1)

        width, height = screen.get_size()
        screen.fill(BG)
        title, body, small, mono = fonts
        exp = experiments[selected]
        text(screen, title, "Pole-balancing experiments", (28, 19))
        text(screen, small, "A small log of random fun ideas I tried out.", (28, 51), MUTED)
        text(screen, body, "PAUSED" if paused else f"RUNNING ×{steps_per_frame}", (width - 28, 28), (247, 190, 70) if paused else (111, 211, 123), "topright")
        margin, gap, top = 28, 18, 82
        sidebar_w = min(320, int(width * .26))
        main_w = width - margin * 2 - gap - sidebar_w
        plot_h = max(150, int(height * .23))
        sim_h = height - top - margin - plot_h - gap
        sim_rect = pygame.Rect(margin, top, main_w, sim_h)
        pygame.draw.rect(screen, SURFACE, sim_rect, border_radius=9)
        text(screen, title, exp.name, (sim_rect.left + 22, sim_rect.top + 18), exp.color)
        text(screen, small, exp.subtitle, (sim_rect.left + 22, sim_rect.top + 51), MUTED)
        text(screen, mono, f"episode {exp.episode}   current {exp.episode_steps} steps", (sim_rect.right - 22, sim_rect.top + 24), MUTED, "topright")
        draw_cartpole(screen, pygame.Rect(sim_rect.left + 22, sim_rect.top + 82, sim_rect.width - 44, sim_rect.height - 160), exp.state, exp.color, exp.flashes > 0)
        stat_y = sim_rect.bottom - 38
        text(screen, body, f"Average  {exp.average:.1f}", (sim_rect.left + 22, stat_y), INK, "midleft")
        text(screen, body, f"Best  {exp.best}", (sim_rect.left + 230, stat_y), INK, "midleft")
        loss = exp.controller.loss
        text(screen, body, "Loss  —" if loss is None else f"Loss  {loss:.4f}", (sim_rect.right - 22, stat_y), INK, "midright")
        draw_selector(screen, pygame.Rect(margin + main_w + gap, top, sidebar_w, sim_h), experiments, selected, fonts)
        plot_w = (main_w - gap) // 2
        plot_y = top + sim_h + gap
        draw_plot(screen, pygame.Rect(margin, plot_y, plot_w, plot_h), list(exp.history), exp.color, "Episode length", fonts, max_value=CartPole.MAX_STEPS)
        draw_plot(screen, pygame.Rect(margin + plot_w + gap, plot_y, plot_w, plot_h), list(exp.loss_history), exp.color, "Training loss", fonts, fixed=exp.controller.loss is None)
        text(screen, small, "← / → choose controller    Space pause    + / − speed    R restart", (width // 2, height - 15), MUTED, "midbottom")
        pygame.display.flip()
        if args.screenshot:
            pygame.image.save(screen, args.screenshot)
            running = False
        clock.tick(60)
    pygame.quit()


if __name__ == "__main__":
    main()
