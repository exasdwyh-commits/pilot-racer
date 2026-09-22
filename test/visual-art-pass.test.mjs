import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('visual art pass activates the dormant lighting and PBR pipeline', () => {
  assert.match(app, /RoomEnvironment/);
  assert.match(app, /scene\.environment\s*=/);
  assert.match(app, /makeDaylightRig/);
  assert.match(app, /daylightRig\.update\(state, dt\)/);
  assert.match(app, /asphalt_track_diff_1k\.png/);
  assert.match(app, /asphalt_track_nor_gl_1k\.png/);
  assert.match(app, /normalMap:\s*waterNormal/);
  assert.match(app, /waterNormal\.offset\.x/);
  assert.match(app, /batchStaticScenery\(trackGroup\)/);
  assert.match(app, /sunTarget\.position\.lerp/);
  assert.match(app, /const skyDome = new THREE\.Mesh/);
  assert.match(app, /skyUniforms\.sunDirection/);
  assert.match(app, /toneMappingExposure = 1\.08 - daylightBlend \* 0\.05/);
  assert.match(app, /shadowRange = spectator \? 165 : 95/);
  assert.match(server, /environments\/RoomEnvironment\.js/);
});

test('redesigned Bay scenery is track-relative instead of pinned to the old world layout', () => {
  assert.match(app, /function buildYachtAt\(s, lane/);
  assert.match(app, /const marinaS = TRACK_LENGTH \* 0\.135/);
  assert.match(app, /const s = \(0\.025 \+ i \/ 38 \* 0\.94/);
  assert.doesNotMatch(app, /box\(TG, -35, -1, 138/);
  assert.doesNotMatch(app, /box\(scene, x, h \/ 2 \+ 0\.5/);
  assert.match(app, /pm\.position\.set\(p\.x, p\.y, p\.z\)/);
  assert.match(app, /const cameraSightLines = broadcastTemplates\(trackId\)/);
  assert.match(app, /clearsBroadcastSight\(p, buildingRadius\)/);
  assert.match(app, /clearsBroadcastSight\(p, 2\.4\)/);
});

test('quality pipeline keeps graceful fallbacks instead of making art assets a startup dependency', () => {
  assert.match(app, /hyper3d-source-fallback/);
  assert.match(app, /using procedural fallback/);
  assert.match(app, /customMaterial \|\| material/);
  assert.match(app, /heroBonnet\.visible = myId !== null/);
  assert.match(app, /piece\.visible = false/);
});
