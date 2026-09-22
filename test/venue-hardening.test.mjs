import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');

test('phone quality fails soft after sustained low FPS and preserves manual override', () => {
  assert.match(app, /LOW_FPS_THRESHOLD = 42/);
  assert.match(app, /LOW_FPS_SECONDS = 5/);
  assert.match(app, /!spectator && !qualityLocked && state\?\.phase === 'racing'/);
  assert.match(app, /qualityAutoDowngraded = true/);
  assert.match(app, /qualityLocked = true/);
});

test('venue telemetry publishes FPS, RTT and active quality for playtests', () => {
  assert.match(app, /type: 'probe', nonce: Date\.now\(\)/);
  assert.match(app, /networkRtt = Math\.max/);
  assert.match(app, /autoQuality: qualityAutoDowngraded/);
  assert.match(app, /rtt: networkRtt/);
});
