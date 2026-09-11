"""Classic cart-pole physics (same dynamics/constants as Gym's CartPole-v1)."""
import numpy as np


class CartPole:
    GRAVITY = 9.8
    MASS_CART = 1.0
    MASS_POLE = 0.1
    LENGTH = 0.5          # half pole length
    FORCE_MAG = 10.0
    TAU = 0.02            # seconds per step
    X_LIMIT = 2.4
    THETA_LIMIT = 12 * np.pi / 180
    MAX_STEPS = 1000

    def __init__(self, seed=0):
        self.rng = np.random.default_rng(seed)
        self.state = np.zeros(4)
        self.steps = 0
        self.reset()

    def reset(self):
        self.state = self.rng.uniform(-0.05, 0.05, size=4)
        self.steps = 0
        return self.state.copy()

    def step(self, force):
        """Apply a horizontal force (clipped to +-FORCE_MAG). Returns (state, reward, done)."""
        force = float(np.clip(force, -self.FORCE_MAG, self.FORCE_MAG))
        x, x_dot, th, th_dot = self.state
        total_m = self.MASS_CART + self.MASS_POLE
        pm_l = self.MASS_POLE * self.LENGTH
        cos, sin = np.cos(th), np.sin(th)

        temp = (force + pm_l * th_dot ** 2 * sin) / total_m
        th_acc = (self.GRAVITY * sin - cos * temp) / (
            self.LENGTH * (4.0 / 3.0 - self.MASS_POLE * cos ** 2 / total_m)
        )
        x_acc = temp - pm_l * th_acc * cos / total_m

        x += self.TAU * x_dot
        x_dot += self.TAU * x_acc
        th += self.TAU * th_dot
        th_dot += self.TAU * th_acc
        self.state = np.array([x, x_dot, th, th_dot])
        self.steps += 1

        done = (
            abs(x) > self.X_LIMIT
            or abs(th) > self.THETA_LIMIT
            or self.steps >= self.MAX_STEPS
        )
        return self.state.copy(), 1.0, done
