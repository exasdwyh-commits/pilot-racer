import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('display uses authored TV camera stations instead of three generic spectator angles', () => {
  assert.match(app, /resolveBroadcastTemplate/);
  assert.match(app, /broadcastPose/);
  assert.match(app, /state\.shot === 'finish'/);
  assert.match(app, /state\.shot === 'aerial'/);
  assert.match(app, /auto:trackside/);
  assert.match(app, /manual:station/);
  assert.match(app, /manual:chase/);
  assert.match(app, /manual:helicopter/);
  assert.doesNotMatch(app, /Spectator Panoramic High View/);
  assert.doesNotMatch(app, /Spectator Side Action Track View/);
});

test('television camera changes are real cuts while a station pans smoothly', () => {
  assert.match(app, /const cut = newCameraKey !== cameraCutKey/);
  assert.match(app, /if \(!cameraInit \|\| cut\)/);
  assert.match(app, /camera\.position\.copy\(targetCamera\)/);
  assert.match(app, /smoothLook\.lerp\(look, alpha\)/);
});

test('free director exposes driver, shot-style and station controls', () => {
  for (const id of ['auto','next','angle','camera-prev','camera-next','camera-station']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /BracketLeft/);
  assert.match(app, /BracketRight/);
  assert.match(app, /KeyA/);
  assert.match(app, /KeyN/);
  assert.match(app, /赛道机位/);
});
