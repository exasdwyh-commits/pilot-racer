import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MODELS = [
  '02-cobalt-manta.glb',
  '03-jade-lynx.glb',
  '04-crimson-kestrel.glb',
  '05-violet-nautilus.glb',
  '06-teal-courier.glb',
  '07-amber-dune.glb',
  '08-obsidian-pulse.glb',
];

function glbJson(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'glTF');
  assert.equal(buffer.readUInt32LE(4), 2, 'GLB version');
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.toString('ascii', 16, 20), 'JSON');
  return JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength).trim());
}

test('02-08 Hyper3D runtime karts are local, compact and renderable', () => {
  for (const filename of MODELS) {
    const buffer = readFileSync(new URL(`../assets/models/hyper3d-tech-roster/runtime/${filename}`, import.meta.url));
    assert.ok(buffer.byteLength > 250_000, `${filename} contains geometry and texture data`);
    assert.ok(buffer.byteLength < 1_800_000, `${filename} stays inside the mobile-web transfer budget`);
    const gltf = glbJson(buffer);
    assert.ok(gltf.meshes?.length >= 1, `${filename} has a mesh`);
    assert.ok(gltf.materials?.length >= 1, `${filename} has a material`);
    assert.ok(gltf.images?.length >= 1, `${filename} embeds its texture`);
  }
});

test('race client assigns a real GLB to all eight slots without changing authoritative simulation', () => {
  const app = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const simulation = readFileSync(new URL('../public/simulation.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes('crimson-kart-parts-candidate.glb'), '01 uses the retained split Hyper3D kart');
  for (const filename of MODELS) assert.ok(app.includes(filename), `${filename} is assigned to a race slot`);
  for (const filename of MODELS) {
    const source = filename.replace('.glb', '-shaded.glb');
    assert.ok(app.includes(source), `${source} is a committed source fallback when runtime output is absent`);
  }
  assert.match(app, /if \(playerId !== null\) return loadRuntimeKart\(playerId\)/, 'phones load only their own kart');
  assert.match(app, /using procedural fallback/, 'a failed GLB keeps the procedural kart');
  assert.match(app, /steer_front_xpos/, 'split kart can reuse authored front steering pivots');
  assert.match(app, /wheel_rear_xneg/, 'split kart can reuse authored wheel spin pivots');
  assert.ok(!simulation.includes('KART_MODEL_FILES'), 'model URLs do not enter simulation state');
});
