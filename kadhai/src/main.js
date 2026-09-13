import './style.css';
import { Habitat, WIDTH, HEIGHT, DURATION } from './simulation.js';

const $ = id => document.getElementById(id);
const canvas = document.createElement('canvas');
canvas.setAttribute('aria-label', 'Floating soft cells and nutrients. Use the controls to change evolution or pause.');
$('habitat').appendChild(canvas);
const ctx = canvas.getContext('2d');
let habitat, paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
let selected = 0, wire = false, speed = 1, zoom = 1, pan = { x: 0, y: 0 };
let w = 0, h = 0, scale = 1, ox = 0, oy = 0;
function resize() {
  const r = $('habitat').getBoundingClientRect(); w = r.width; h = r.height;
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe($('habitat'));
function transform() {
  const mobile = w < 600;
  const available = mobile ? w - 30 : w - (w < 900 ? 300 : 365);
  scale = Math.min(available / WIDTH, (h - (mobile ? 140 : 185)) / HEIGHT) * zoom;
  ox = (available - WIDTH * scale) / 2 + (mobile ? 15 : 22) + pan.x;
  oy = (h - HEIGHT * scale) / 2 + (mobile ? 47 : 40) + pan.y;
}
function xy(x, y) { return [ox + x * scale, oy + y * scale]; }
function path(points, factor = 1) {
  const cx = points[0][0], cy = points[0][1];
  const ring = points.slice(1).map(p => xy(cx + (p[0] - cx) * factor, cy + (p[1] - cy) * factor));
  ctx.beginPath();
  const last = ring.at(-1), first = ring[0];
  ctx.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], next = ring[(i + 1) % ring.length];
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + next[0]) / 2, (p[1] + next[1]) / 2);
  }
  ctx.closePath();
}
function draw() {
  transform(); ctx.clearRect(0, 0, w, h);
  const bg = ctx.createRadialGradient(w * .4, h * .5, 20, w * .4, h * .5, w * .7);
  bg.addColorStop(0, '#edf5f7'); bg.addColorStop(1, '#d8e6ec');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  if (!habitat) return;
  ctx.save();
  // A faint field of specks makes the transparent fluid visible without a grid.
  for (let i = 0; i < 150; i++) {
    const x = ((i * 193.17) % w), y = ((i * 91.33) % h);
    ctx.fillStyle = '#7095a211'; ctx.beginPath(); ctx.arc(x, y, .7, 0, Math.PI * 2); ctx.fill();
  }
  for (const f of habitat.food) {
    const [x, y] = xy(f.x, f.y);
    const radius = (1.3 + f.glow) * Math.min(1.3, scale / 20);
    ctx.fillStyle = '#86ab9360'; ctx.beginPath(); ctx.arc(x, y, radius + 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#7b9f76'; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  }
  for (const c of habitat.cells) drawCell(c);
  ctx.restore();
}
function drawCell(c) {
  const hue = c.g.hue;
  const [x, y] = xy(...c.points[0]);
  const r = scale * c.g.length * c.growth;
  if (c.id === selected) {
    path(c.points, 1.23); ctx.strokeStyle = `hsla(${hue},25%,45%,.4)`;
    ctx.lineWidth = 1; ctx.setLineDash([3, 5]); ctx.stroke(); ctx.setLineDash([]);
  }
  path(c.points);
  const fill = ctx.createRadialGradient(x - r * .3, y - r * .4, 0, x, y, r * 1.5);
  fill.addColorStop(0, `hsla(${hue},40%,90%,.7)`);
  fill.addColorStop(.55, `hsla(${hue},36%,76%,.65)`);
  fill.addColorStop(1, `hsla(${hue},34%,55%,.7)`);
  ctx.shadowColor = `hsla(${hue},30%,40%,.15)`; ctx.shadowBlur = 12; ctx.shadowOffsetY = 5;
  ctx.fillStyle = fill; ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.lineWidth = 2; ctx.strokeStyle = `hsla(${hue},28%,48%,.55)`; ctx.stroke();
  path(c.points, .91); ctx.strokeStyle = '#ffffff77'; ctx.lineWidth = 1; ctx.stroke();
  if (wire) {
    ctx.strokeStyle = `hsla(${hue},30%,35%,.3)`; ctx.lineWidth = .7;
    for (let i = 1; i < c.points.length; i++) { const p = xy(...c.points[i]); ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(...p); ctx.stroke(); }
  }
  // Nucleus and organelles follow actual mesh vertices; only their drawing is decorative.
  ctx.save(); path(c.points, .88); ctx.clip();
  for (let i = 0; i < 7; i++) {
    const vertex = c.points[1 + (i * 3) % (c.points.length - 1)];
    const px = x + (vertex[0] * scale + ox - x) * .57;
    const py = y + (vertex[1] * scale + oy - y) * .57;
    ctx.fillStyle = `hsla(${hue},30%,47%,.15)`; ctx.beginPath(); ctx.ellipse(px,py,scale * .1,scale * .065,i,0,Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = `hsla(${hue},32%,47%,.24)`; ctx.strokeStyle = `hsla(${hue},26%,39%,.2)`;
  ctx.beginPath(); ctx.ellipse(x - r * .07, y + r * .05, r * .26, r * .22, c.g.phase, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffffff55'; ctx.beginPath(); ctx.arc(x - r * .14, y - r * .03, r * .075, 0, Math.PI * 2); ctx.fill();
  if (c.flashes > 0) { ctx.globalAlpha = c.flashes * .25; path(c.points); ctx.fillStyle = '#fff'; ctx.fill(); }
  ctx.restore();
  if (c.id === selected) {
    ctx.font = '10px "DM Sans", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#58727e';
    ctx.fillText(`cell ${String(c.id + 1).padStart(2, '0')}`, x, y + scale * c.g.width * c.growth * 1.6 + 13);
  }
}
function ui() {
  if (!habitat) return;
  $('generation').textContent = String(habitat.generation).padStart(2, '0');
  $('progress').style.width = `${habitat.elapsed / DURATION * 100}%`;
  $('age').textContent = habitat.elapsed < 16 ? 'Growing & feeding' : 'Feeding & selecting';
  $('remaining').textContent = `${Math.ceil(DURATION - habitat.elapsed)}s`;
  $('best').textContent = habitat.totalFood;
  $('variety').textContent = `${habitat.variety.toFixed(2)}`;
  $('variety').title = 'Standard deviation of inherited length-to-width ratios';
  $('state').textContent = paused ? 'Paused' : 'Drifting';
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  const c = habitat.cells[selected];
  $('specimen-name').textContent = `Cell ${String(c.id + 1).padStart(2, '0')}`;
  $('specimen-info').textContent = `${c.g.lobes} lobes · ${c.food} nutrients · ${c.parent ? `parent ${String(c.parent).padStart(2,'0')}` : 'founder'}`;
  $('specimen-shape').textContent = c.growth < .99 ? `${Math.round(c.growth * 100)}% grown` : 'Mature';
  document.querySelector('.specimen-dot').style.background = `hsl(${c.g.hue},35%,65%)`;
}
let noticeTimer;
function notice(message) { $('notice').textContent = message; $('notice').classList.add('visible'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').classList.remove('visible'), 3500); }
$('pause').onclick = () => { paused = !paused; ui(); };
$('next').onclick = () => { if (!habitat) return; habitat.nextGeneration(); notice('Three survivors. A new generation of shapes.'); ui(); draw(); };
$('reset').onclick = () => {
  if (!habitat) { location.reload(); return; }
  habitat.reset(crypto.getRandomValues(new Uint32Array(1))[0]); habitat.mutation = +$('mutation').value / 100;
  selected = 0; notice('A new lineage is floating into life.'); ui(); draw();
};
$('mutation').oninput = e => { if (habitat) habitat.mutation = +e.target.value / 100; $('mutation-value').textContent = `${e.target.value}%`; };
$('speed').oninput = e => { speed = +e.target.value; $('speed-value').textContent = `${speed}×`; };
$('wire').onclick = () => { wire = !wire; $('wire').setAttribute('aria-pressed', wire); $('wire').textContent = wire ? 'Hide structure' : 'Show structure'; draw(); };
$('view').onclick = () => { zoom = 1; pan = { x: 0, y: 0 }; draw(); };
let pointer;
canvas.addEventListener('pointerdown', e => { pointer = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => { if (pointer) { pan.x = pointer.px + e.clientX - pointer.x; pan.y = pointer.py + e.clientY - pointer.y; draw(); } });
canvas.addEventListener('pointerup', e => {
  if (pointer && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 5 && habitat) {
    const rect = canvas.getBoundingClientRect();
    let closest = Infinity;
    for (const c of habitat.cells) { const [x,y] = xy(...c.points[0]); const distance = Math.hypot(e.clientX - rect.left - x, e.clientY - rect.top - y); if (distance < closest && distance < scale * 2.5) { closest = distance; selected = c.id; } }
    ui(); draw();
  }
  pointer = null;
});
canvas.addEventListener('pointercancel', () => { pointer = null; });
canvas.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.max(.65, Math.min(2.5, zoom * Math.exp(-e.deltaY * .001))); draw(); }, { passive: false });
canvas.style.touchAction = 'none';

let last = 0, accumulator = 0, lastUi = 0;
function frame(now) {
  const dt = last ? Math.min((now - last) / 1000, .1) : 0; last = now;
  if (habitat && !paused) {
    accumulator += dt * speed;
    try {
      for (let steps = 0; accumulator >= 1 / 30 && steps < 12; steps++) { habitat.step(); accumulator -= 1 / 30; }
    } catch (error) { paused = true; notice(error.message); console.error(error); }
  } else accumulator = 0;
  draw(); if (now - lastUi > 120) { ui(); lastUi = now; }
  requestAnimationFrame(frame);
}
async function start() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}vendor/algovivo/algovivo.wasm`);
    if (!response.ok) throw new Error(`Could not load Algovivo (${response.status}).`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
    habitat = new Habitat(instance); ui();
    // Read-only inspection for reproducible browser checks and lab-notebook captures.
    window.kadhai = { snapshot: () => habitat.snapshot() };
  } catch (error) { $('state').textContent = 'Could not load'; notice(`${error.message} Try reloading the page.`); console.error(error); }
}
resize(); requestAnimationFrame(frame); start();
