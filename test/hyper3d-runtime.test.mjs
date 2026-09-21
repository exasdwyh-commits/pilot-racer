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

test('race client installs Hyper3D shells without changing authoritative simulation', () => {
  const app = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const simulation = readFileSync(new URL('../public/simulation.mjs', import.meta.url), 'utf8');
  for (const filename of MODELS) assert.ok(app.includes(filename), `${filename} is assigned to a race slot`);
  assert.match(app, /if \(playerId !== null\) return loadRuntimeKart\(playerId\)/, 'phones load only their own kart');
  assert.match(app, /using procedural fallback/, 'a failed GLB keeps the procedural kart');
  assert.ok(!simulation.includes('KART_MODEL_FILES'), 'model URLs do not enter simulation state');
});
