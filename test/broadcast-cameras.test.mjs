import test from 'node:test';
import assert from 'node:assert/strict';
import {
  broadcastTemplates,
  broadcastTemplateById,
  resolveBroadcastTemplate,
  nextBroadcastTemplate,
  broadcastPose,
  broadcastMap,
} from '../public/broadcast-cameras.mjs';
import { TRACK_LENGTH, useTrack } from '../public/simulation.mjs';

for (const trackId of ['bay','ridge']) {
  test(`${trackId} TV camera map covers the full lap with named fixed stations`, () => {
    useTrack(trackId);
    const templates = broadcastTemplates(trackId);
    assert.ok(templates.length >= 7, 'enough stations to avoid one generic camera');
    assert.equal(new Set(templates.map(t => t.id)).size, templates.length, 'station ids are unique');
    for (let i = 0; i < 400; i++) {
      const s = i / 400 * TRACK_LENGTH;
      const template = resolveBroadcastTemplate(trackId, s);
      assert.ok(template, `camera exists at lap ratio ${(i/400).toFixed(3)}`);
      assert.ok(template.label.length >= 4, 'station carries a readable TV label');
    }
    const map = broadcastMap(trackId);
    assert.equal(map.trackId, trackId);
    assert.equal(map.templates.length, templates.length);
  });

  test(`${trackId} fixed TV station pans at cars without turning into a chase camera`, () => {
    useTrack(trackId);
    const template = broadcastTemplates(trackId)[2];
    const a = broadcastPose(trackId, template, TRACK_LENGTH * .25, -2);
    const b = broadcastPose(trackId, template, TRACK_LENGTH * .31, 2);
    assert.deepEqual(a.camera, b.camera, 'camera body remains bolted to the map');
    assert.notDeepEqual(a.look, b.look, 'operator pans to follow the moving subject');
    for (const value of [...Object.values(a.camera), ...Object.values(a.look)]) {
      assert.ok(Number.isFinite(value), 'camera pose remains finite');
    }
    assert.ok(a.fov >= 35 && a.fov <= 60, 'broadcast lens stays television-like');
  });
}

test('free director can step through camera stations and wrap around', () => {
  const list = broadcastTemplates('bay');
  const first = list[0];
  const next = nextBroadcastTemplate('bay', first.id, 1);
  assert.equal(next.id, list[1].id);
  const wrapped = nextBroadcastTemplate('bay', first.id, -1);
  assert.equal(wrapped.id, list.at(-1).id);
  assert.equal(broadcastTemplateById('bay', wrapped.id)?.id, wrapped.id);
});

test('tunnel exit stations sit beyond the physical tunnel cover', () => {
  const bay = broadcastTemplateById('bay', 'bay-tunnel');
  const ridge = broadcastTemplateById('ridge', 'ridge-tunnel');
  assert.ok(bay.at > 0.735, 'Bay camera anchor is beyond the covered tunnel');
  assert.ok(ridge.at > 0.78, 'Ridge camera anchor is beyond the covered tunnel');
  assert.notEqual(bay.style, 'exit', 'Bay station no longer pulls itself back into the tunnel');
  assert.notEqual(ridge.style, 'exit', 'Ridge station no longer pulls itself back into the tunnel');
});
