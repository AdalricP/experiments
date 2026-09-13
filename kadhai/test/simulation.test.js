import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Habitat, genome, makeMesh, mutate, randomSource, pointInside, DURATION } from '../src/simulation.js';
const bytes = await readFile(new URL('../public/vendor/algovivo/algovivo.wasm', import.meta.url));
async function habitat(seed = 42) { const { instance } = await WebAssembly.instantiate(bytes); return new Habitat(instance, seed); }

test('mutations produce valid positively oriented triangle fans', () => {
  const rng = randomSource(7); let g = genome(rng);
  for (let j = 0; j < 1000; j++) {
    g = mutate(g, .9, rng); const mesh = makeMesh(g);
    for (const [a,b,c] of mesh.triangles) {
      const p=mesh.pos[a], q=mesh.pos[b], r=mesh.pos[c];
      assert.ok((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]) > 0);
    }
    assert.ok(pointInside(0,0,mesh.pos)); assert.ok(!pointInside(20,20,mesh.pos));
  }
});
test('zero gravity and floor, feeding, growth, finite physics, selection and inheritance', async () => {
  const h = await habitat(); const before = h.snapshot();
  for (const c of h.cells) { assert.equal(c.system.g,0); assert.equal(c.system.friction.k,0); assert.equal(c.system.collision.k,0); }
  h.food[0] = {x:h.cells[0].points[0][0],y:h.cells[0].points[0][1],glow:0};
  h.step(); assert.ok(h.cells[0].food >= 1);
  for (let i=1;i<600;i++) h.step();
  assert.equal(h.cells[0].growth,1);
  assert.notDeepEqual(h.cells[0].points,before.cells[0].points);
  const ranked=[...h.cells].sort((a,b)=>b.score-a.score);
  const best={...ranked[0].g}; const ids=ranked.slice(0,3).map(c=>c.id+1);
  h.nextGeneration(); assert.equal(h.generation,2); assert.deepEqual(h.cells[0].g,best);
  assert.ok(h.cells.every(c=>ids.includes(c.parent)));
  assert.ok(h.cells.slice(1).some(c=>JSON.stringify(c.g)!==JSON.stringify(best)));
  for(let i=0;i<DURATION*30*2;i++) h.step();
  assert.equal(h.generation,4); assert.equal(h.failures,0);
  assert.ok(h.cells.every(c=>c.points.flat().every(Number.isFinite)));
  assert.equal(h.history.length,3);
  console.log('Observed:',JSON.stringify(h.history.map(({generation,best,food})=>({generation,best,food}))));
});
test('seeded replay matches and reset clears the lineage', async () => {
  const a=await habitat(123),b=await habitat(123);
  for(let i=0;i<30;i++){a.step();b.step();}
  assert.deepEqual(a.snapshot(),b.snapshot());
  a.nextGeneration(); a.reset(123); assert.equal(a.generation,1); assert.equal(a.history.length,0);
  assert.equal(a.totalFood,0); assert.equal(a.cells.length,12);
});
