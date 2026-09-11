"""Classical / non-neural controllers for cart-pole.

Controller API used by the UI:
    act(state) -> force            pick a force for this step
    learn(s, r, s2, done)          (optional) online update after env.step
    episode_end()                  (optional) called on episode reset
    loss                           float or None, shown in the stats table
    info                           short extra string shown in the pane
"""
import numpy as np

from cartpole import CartPole


class Controller:
    loss = None
    info = ""

    def act(self, state):
        raise NotImplementedError

    def learn(self, state, reward, next_state, done):
        pass

    def episode_end(self):
        pass


class RandomController(Controller):
    """Baseline: uniform random bang-bang force."""

    def __init__(self, seed=0):
        self.rng = np.random.default_rng(seed)

    def act(self, state):
        return self.rng.choice([-CartPole.FORCE_MAG, CartPole.FORCE_MAG])


class PIDController(Controller):
    """PID on pole angle plus a weak P/D term on cart position to stay centered."""

    def __init__(self, kp=40.0, ki=15.0, kd=6.0, kx=1.0, kxd=1.8):
        self.kp, self.ki, self.kd = kp, ki, kd
        self.kx, self.kxd = kx, kxd
        self.integral = 0.0

    def act(self, state):
        x, x_dot, th, th_dot = state
        self.integral = np.clip(self.integral + th * CartPole.TAU, -0.5, 0.5)
        force = (
            self.kp * th + self.ki * self.integral + self.kd * th_dot
            + self.kx * x + self.kxd * x_dot
        )
        return force

    def episode_end(self):
        self.integral = 0.0


def lqr_gain(q_diag=(1.0, 1.0, 10.0, 1.0), r=0.1):
    """Discrete LQR gain for the cart-pole linearized about upright."""
    g, mc, mp, l, tau = (
        CartPole.GRAVITY, CartPole.MASS_CART, CartPole.MASS_POLE,
        CartPole.LENGTH, CartPole.TAU,
    )
    total_m = mc + mp
    denom = l * (4.0 / 3.0 - mp / total_m)
    # Continuous-time linearization, state [x, x_dot, theta, theta_dot]
    a_c = np.array([
        [0, 1, 0, 0],
        [0, 0, -mp * l * g / (total_m * denom), 0],
        [0, 0, 0, 1],
        [0, 0, g / denom, 0],
    ])
    b_c = np.array([
        [0],
        [1 / total_m + mp * l / (total_m ** 2 * denom)],
        [0],
        [-1 / (total_m * denom)],
    ])
    a = np.eye(4) + tau * a_c
    b = tau * b_c
    q = np.diag(q_diag)
    r = np.array([[r]])
    # Iterate the discrete Riccati equation to convergence
    p = q.copy()
    for _ in range(500):
        k = np.linalg.solve(r + b.T @ p @ b, b.T @ p @ a)
        p_next = q + a.T @ p @ (a - b @ k)
        if np.max(np.abs(p_next - p)) < 1e-9:
            p = p_next
            break
        p = p_next
    k = np.linalg.solve(r + b.T @ p @ b, b.T @ p @ a)
    return k.flatten()


class LQRController(Controller):
    """Optimal linear state feedback u = -Kx from the Riccati equation."""

    def __init__(self):
        self.k = lqr_gain()

    def act(self, state):
        return -float(self.k @ state)


class QLearningController(Controller):
    """Tabular Q-learning over a discretized state space, epsilon-greedy."""

    BINS = (6, 6, 12, 12)
    LOWS = np.array([-2.4, -3.0, -CartPole.THETA_LIMIT, -3.5])
    HIGHS = np.array([2.4, 3.0, CartPole.THETA_LIMIT, 3.5])

    def __init__(self, seed=0, alpha=0.15, gamma=0.99):
        self.rng = np.random.default_rng(seed)
        self.q = np.zeros(self.BINS + (2,))
        self.alpha, self.gamma = alpha, gamma
        self.eps = 1.0
        self.last_action = 1
        self._td_avg = 0.0

    def _index(self, state):
        clipped = np.clip(state, self.LOWS, self.HIGHS - 1e-9)
        frac = (clipped - self.LOWS) / (self.HIGHS - self.LOWS)
        return tuple((frac * np.array(self.BINS)).astype(int))

    def act(self, state):
        idx = self._index(state)
        if self.rng.random() < self.eps:
            self.last_action = int(self.rng.integers(2))
        else:
            self.last_action = int(np.argmax(self.q[idx]))
        return (self.last_action * 2 - 1) * CartPole.FORCE_MAG

    def learn(self, state, reward, next_state, done):
        idx = self._index(state) + (self.last_action,)
        target = reward if done else reward + self.gamma * np.max(self.q[self._index(next_state)])
        td = target - self.q[idx]
        self.q[idx] += self.alpha * td
        self._td_avg = 0.99 * self._td_avg + 0.01 * abs(td)

    def episode_end(self):
        self.eps = max(0.05, self.eps * 0.995)

    @property
    def loss(self):
        return self._td_avg

    @property
    def info(self):
        return f"eps {self.eps:.2f}"
