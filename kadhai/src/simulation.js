import { System } from '../public/vendor/algovivo/algovivo.min.js';

export const COUNT = 12;
export const DURATION = 30;
export const WIDTH = 40;
export const HEIGHT = 28;
export const VERTICES = 24;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function randomSource(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function genome(rng) {
  return { length: .9 + rng() * .6, width: .7 + rng() * .5,
    lobes: 2 + Math.floor(rng() * 4), depth: .08 + rng() * .24,
    asymmetry: (rng() - .5) * .3, phase: rng() * TAU,
    rhythm: .65 + rng(), pulse: .08 + rng() * .16, hue: rng() * 360 };
}
export function mutate(parent, amount, rng) {
  const child = { ...parent };
  const change = (key, range, min, max) => { child[key] = clamp(child[key] + (rng() - .5) * range * amount, min, max); };
  change('length', 1.4, .65, 1.9); change('width', 1.2, .55, 1.6);
  change('depth', .6, .03, .38); change('asymmetry', .6, -.25, .25);
  change('rhythm', 1.4, .4, 2); change('pulse', .35, .04, .28);
  if (rng() < amount) child.lobes = clamp(child.lobes + (rng() < .5 ? -1 : 1), 2, 6);
  child.phase += (rng() - .5) * amount * 2;
  child.hue = (child.hue + (rng() - .5) * 55 * amount + 360) % 360;
  return child;
}
export function makeMesh(g) {
  const pos = [[0, 0]], triangles = [], muscles = [];
  for (let i = 0; i < VERTICES; i++) {
    const angle = i / VERTICES * TAU;
    const radius = 1 + g.depth * Math.cos(angle * g.lobes + g.phase) + g.asymmetry * Math.sin(angle);
    pos.push([Math.cos(angle) * radius * g.length, Math.sin(angle) * radius * g.width]);
    triangles.push([0, i + 1, (i + 1) % VERTICES + 1]);
    muscles.push([0, i + 1]);
  }
  return { pos, triangles, muscles };
}
export function pointInside(x, y, points) {
  let inside = false;
  for (let i = 1, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function bodyArea(points) {
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i], b = points[i === points.length - 1 ? 1 : i + 1];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}

export class Habitat {
  constructor(wasmInstance, seed = 42) {
    this.wasmInstance = wasmInstance;
    this.reset(seed);
  }
  reset(seed = 42) {
    this.cells?.forEach(c => c.system.dispose());
    this.rng = randomSource(seed); this.seed = seed; this.generation = 1;
    this.elapsed = 0; this.time = 0; this.mutation = .35; this.history = [];
    this.cells = []; this.food = []; this.totalFood = 0; this.failures = 0;
    this.spawn(Array.from({ length: COUNT }, () => genome(this.rng)));
    for (let i = 0; i < 230; i++) this.food.push(this.newFood());
  }
  newFood() { return { x: 1 + this.rng() * (WIDTH - 2), y: 1 + this.rng() * (HEIGHT - 2), glow: this.rng() }; }
  spawn(genes, parents = []) {
    this.cells.forEach(c => c.system.dispose());
    this.cells = [];
    genes.forEach((g, i) => {
      const system = new System(this.cells.length ? { ten: this.cells[0].system.ten } : { wasmInstance: this.wasmInstance });
      const mesh = makeMesh(g);
      // Algovivo supplies elasticity and muscle forces. Disable its floor entirely.
      system.g = 0; system.friction.k = 0; system.collision.k = 0; system.h = 1 / 30;
      const origin = [6 + (i % 4) * 9 + (this.rng() - .5), 5 + Math.floor(i / 4) * 9 + (this.rng() - .5)];
      system.set({ ...mesh, pos: mesh.pos.map(p => [p[0] + origin[0], p[1] + origin[1]]) });
      system.k = 55;
      const restInverse = Float32Array.from(system.rsi.typedArray());
      const restLengths = Float32Array.from(system.l0.typedArray());
      const birth = .48;
      system.pos.set(mesh.pos.map(p => [p[0] * birth + origin[0], p[1] * birth + origin[1]]));
      const cell = { id: i, g, system, restInverse, restLengths, mesh, growth: birth,
        points: system.pos.toArray(), food: 0, cost: 0, score: 0, parent: parents[i] ?? null,
        drift: this.rng() * TAU, flashes: 0 };
      this.cells.push(cell); this.setGrowth(cell, birth);
    });
  }
  setGrowth(c, scale) {
    c.growth = scale;
    const inverse = c.system.rsi.typedArray(), lengths = c.system.l0.typedArray();
    for (let i = 0; i < inverse.length; i++) inverse[i] = c.restInverse[i] / scale;
    for (let i = 0; i < lengths.length; i++) lengths[i] = c.restLengths[i] * scale;
  }
  nextGeneration() {
    const ranked = [...this.cells].sort((a, b) => b.score - a.score);
    const survivors = ranked.slice(0, 3);
    this.history.push({ generation: this.generation, best: ranked[0].score, food: this.totalFood,
      genes: this.cells.map(c => ({ ...c.g })), winner: ranked[0].id });
    if (this.history.length > 100) this.history.shift();
    const parents = Array.from({ length: COUNT }, (_, i) => survivors[i % 3]);
    // Keep the best genome unchanged as an experimental control; mutate the rest.
    const genes = parents.map((p, i) => i === 0 ? { ...p.g } : mutate(p.g, this.mutation, this.rng));
    this.spawn(genes, parents.map(p => p.id + 1));
    this.generation++; this.elapsed = 0; this.totalFood = 0;
    this.food = Array.from({ length: 230 }, () => this.newFood());
  }
  step() {
    const dt = 1 / 30; this.elapsed += dt; this.time += dt;
    for (const c of this.cells) {
      this.setGrowth(c, .48 + .52 * Math.min(1, this.elapsed / 16));
      const a = c.system.a.typedArray();
      for (let i = 0; i < a.length; i++) a[i] = 1 - c.g.pulse * (.5 + .5 * Math.sin(this.time * c.g.rhythm * 2 + i / VERTICES * TAU + c.g.phase));
      const vel = c.system.vel.typedArray(), pos = c.system.pos.typedArray();
      const cx = pos[0], cy = pos[1];
      // A weak fluid current causes drift, not locomotion; viscosity damps motion.
      let fx = .35 * Math.cos(c.drift + this.time * .09) + .13 * Math.sin(cy * .3 + this.time * .1);
      let fy = .35 * Math.sin(c.drift + this.time * .09) + .13 * Math.cos(cx * .3 - this.time * .1);
      fx += Math.max(0, 3 - cx) * .8 - Math.max(0, cx - WIDTH + 3) * .8;
      fy += Math.max(0, 3 - cy) * .8 - Math.max(0, cy - HEIGHT + 3) * .8;
      for (const other of this.cells) {
        if (other === c) continue;
        const dx = cx - other.points[0][0], dy = cy - other.points[0][1], d = Math.hypot(dx, dy);
        if (d > .001 && d < 3.5) { fx += dx / d * (3.5 - d) * .6; fy += dy / d * (3.5 - d) * .6; }
      }
      for (let i = 0; i < vel.length; i += 2) { vel[i] = vel[i] * .975 + fx * dt; vel[i + 1] = vel[i + 1] * .975 + fy * dt; }
      c.system.step();
      c.points = c.system.pos.toArray();
      if (!c.points.flat().every(Number.isFinite)) { this.failures++; throw new Error('The soft-body solver became unstable. Start a new lineage to reset.'); }
      c.cost += bodyArea(c.points) * dt * .035;
      for (let i = 0; i < this.food.length; i++) {
        const f = this.food[i];
        if (Math.abs(f.x - c.points[0][0]) < 4 && Math.abs(f.y - c.points[0][1]) < 4 && pointInside(f.x, f.y, c.points)) {
          c.food++; this.totalFood++; c.flashes = 1; this.food[i] = this.newFood();
        }
      }
      c.flashes = Math.max(0, c.flashes - dt * 1.5);
      c.score = c.food - c.cost;
    }
    if (this.elapsed + 1e-8 >= DURATION) this.nextGeneration();
  }
  get variety() {
    const mean = this.cells.reduce((sum, c) => sum + c.g.length / c.g.width, 0) / COUNT;
    return Math.sqrt(this.cells.reduce((sum, c) => sum + (c.g.length / c.g.width - mean) ** 2, 0) / COUNT);
  }
  snapshot() {
    return { generation: this.generation, elapsed: this.elapsed, totalFood: this.totalFood, failures: this.failures,
      variety: this.variety, history: this.history, cells: this.cells.map(c => ({ id: c.id, parent: c.parent,
        genome: c.g, growth: c.growth, food: c.food, score: c.score, points: c.points })) };
  }
}
