"""Neural RL agents (torch): REINFORCE, PPO, and an RL+LQR shielded hybrid.

All agents learn online while being rendered. Actions are discrete
{push left, push right} at full force, like classic CartPole.
"""
import numpy as np
import torch
import torch.nn as nn

from cartpole import CartPole
from controllers import Controller, lqr_gain

torch.manual_seed(0)


def mlp(out_dim):
    return nn.Sequential(nn.Linear(4, 64), nn.Tanh(), nn.Linear(64, out_dim))


class ReinforceAgent(Controller):
    """Vanilla policy gradient (REINFORCE) with normalized returns, updates each episode."""

    def __init__(self, lr=1e-2, gamma=0.99):
        self.policy = mlp(2)
        self.opt = torch.optim.Adam(self.policy.parameters(), lr=lr)
        self.gamma = gamma
        self.log_probs = []
        self.rewards = []
        self._loss = None

    def act(self, state):
        logits = self.policy(torch.as_tensor(state, dtype=torch.float32))
        dist = torch.distributions.Categorical(logits=logits)
        action = dist.sample()
        self.log_probs.append(dist.log_prob(action))
        return (action.item() * 2 - 1) * CartPole.FORCE_MAG

    def learn(self, state, reward, next_state, done):
        self.rewards.append(reward)

    def episode_end(self):
        if not self.rewards:
            return
        returns, running = [], 0.0
        for r in reversed(self.rewards):
            running = r + self.gamma * running
            returns.append(running)
        returns = torch.tensor(list(reversed(returns)), dtype=torch.float32)
        returns = (returns - returns.mean()) / (returns.std() + 1e-8)
        loss = -(torch.stack(self.log_probs) * returns).mean()
        self.opt.zero_grad()
        loss.backward()
        self.opt.step()
        self._loss = loss.item()
        self.log_probs, self.rewards = [], []

    @property
    def loss(self):
        return self._loss


class PPOAgent(Controller):
    """PPO-clip with GAE, updating every ROLLOUT steps (across episode boundaries)."""

    ROLLOUT = 512
    EPOCHS = 4
    MINIBATCH = 128
    CLIP = 0.2

    def __init__(self, lr=1e-3, gamma=0.99, lam=0.95):
        self.actor = mlp(2)
        self.critic = mlp(1)
        self.opt = torch.optim.Adam(
            list(self.actor.parameters()) + list(self.critic.parameters()), lr=lr
        )
        self.gamma, self.lam = gamma, lam
        self.buf = {k: [] for k in ("obs", "act", "logp", "val", "rew", "done")}
        self._loss = None

    def act(self, state):
        obs = torch.as_tensor(state, dtype=torch.float32)
        with torch.no_grad():
            dist = torch.distributions.Categorical(logits=self.actor(obs))
            action = dist.sample()
            self.buf["obs"].append(obs)
            self.buf["act"].append(action)
            self.buf["logp"].append(dist.log_prob(action))
            self.buf["val"].append(self.critic(obs).squeeze())
        return (action.item() * 2 - 1) * CartPole.FORCE_MAG

    def learn(self, state, reward, next_state, done):
        self.buf["rew"].append(reward)
        self.buf["done"].append(done)
        if len(self.buf["rew"]) >= self.ROLLOUT:
            self._update(next_state, done)

    def _update(self, last_state, last_done):
        obs = torch.stack(self.buf["obs"])
        acts = torch.stack(self.buf["act"])
        old_logp = torch.stack(self.buf["logp"])
        vals = torch.stack(self.buf["val"])
        rews = torch.tensor(self.buf["rew"], dtype=torch.float32)
        dones = torch.tensor(self.buf["done"], dtype=torch.float32)

        with torch.no_grad():
            last_val = 0.0 if last_done else self.critic(
                torch.as_tensor(last_state, dtype=torch.float32)
            ).item()
        n = len(rews)
        adv = torch.zeros(n)
        gae = 0.0
        for t in reversed(range(n)):
            next_val = last_val if t == n - 1 else vals[t + 1].item()
            nonterminal = 1.0 - dones[t].item()
            delta = rews[t] + self.gamma * next_val * nonterminal - vals[t].item()
            gae = delta + self.gamma * self.lam * nonterminal * gae
            adv[t] = gae
        ret = adv + vals
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)

        losses = []
        for _ in range(self.EPOCHS):
            for start in range(0, n, self.MINIBATCH):
                mb = slice(start, start + self.MINIBATCH)
                dist = torch.distributions.Categorical(logits=self.actor(obs[mb]))
                logp = dist.log_prob(acts[mb])
                ratio = torch.exp(logp - old_logp[mb])
                clipped = torch.clamp(ratio, 1 - self.CLIP, 1 + self.CLIP)
                pg_loss = -torch.min(ratio * adv[mb], clipped * adv[mb]).mean()
                v_loss = ((self.critic(obs[mb]).squeeze(-1) - ret[mb]) ** 2).mean()
                loss = pg_loss + 0.5 * v_loss - 0.01 * dist.entropy().mean()
                self.opt.zero_grad()
                loss.backward()
                self.opt.step()
                losses.append(loss.item())
        self._loss = float(np.mean(losses))
        self.buf = {k: [] for k in self.buf}

    @property
    def loss(self):
        return self._loss


class ShieldedRLAgent(Controller):
    """Hybrid: RL proposes the action, LQR has the final say near the limits.

    A REINFORCE policy proposes bang-bang forces. Whenever the state leaves a
    conservative safe set (angle or position too close to termination), the LQR
    controller overrides — a classic 'safety shield' architecture. The RL agent
    still learns from the shared reward stream, so it learns to keep the system
    where its own proposals are trusted.
    """

    SAFE_THETA = 6 * np.pi / 180   # override beyond 6 deg (limit is 12)
    SAFE_X = 1.8                   # override beyond 1.8 m (limit is 2.4)

    def __init__(self):
        self.rl = ReinforceAgent()
        self.k = lqr_gain()
        self.overrides = 0
        self.total = 0

    def act(self, state):
        rl_force = self.rl.act(state)
        self.total += 1
        _, _, th, _ = state
        if abs(th) > self.SAFE_THETA or abs(state[0]) > self.SAFE_X:
            self.overrides += 1
            return -float(self.k @ state)
        return rl_force

    def learn(self, state, reward, next_state, done):
        self.rl.learn(state, reward, next_state, done)

    def episode_end(self):
        self.rl.episode_end()

    @property
    def loss(self):
        return self.rl.loss

    @property
    def info(self):
        if self.total == 0:
            return ""
        return f"shield {100 * self.overrides / self.total:.0f}%"
