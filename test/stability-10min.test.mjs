import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRace, startRace, stepRace, applyInput, useItem, snapshot, TRACK_LENGTH } from '../public/simulation.mjs';

test('10-minute continuous 2-player battle simulation: stability, bounded entities, rematch loops', () => {
  const race = makeRace();
  const [p1, p2] = [race.cars[0], race.cars[1]];
  p1.human = true; p1.connected = true; p1.name = '手机A';
  p2.human = true; p2.connected = true; p2.name = '手机B';

  startRace(race);

  const DT = 1 / 30;
  const TOTAL_SECONDS = 600; // 10 minutes
  const TOTAL_STEPS = TOTAL_SECONDS * 30; // 18,000 steps

  let p1Seq = 0, p2Seq = 0;
  let completedRounds = 0;
  let lastRound = race.round;

  for (let step = 0; step < TOTAL_STEPS; step++) {
    const t = race.time;

    // Send input for Player 1 every 2 steps (~15 Hz)
    if (step % 2 === 0) {
      const steerVal = Math.sin(t * 0.8);
      const driftVal = Math.abs(steerVal) > 0.6;
      const boostVal = p1.energy >= 30 && (step % 120 === 0);
      applyInput(p1, { seq: ++p1Seq, steer: steerVal, drift: driftVal, brake: false, boost: boostVal }, t);
      if (p1.item) useItem(race, p1, t);
    }

    // Send input for Player 2 every 2 steps
    if (step % 2 === 1) {
      const steerVal = -Math.cos(t * 0.7);
      const driftVal = Math.abs(steerVal) > 0.5;
      const boostVal = p2.energy >= 30 && (step % 90 === 0);
      applyInput(p2, { seq: ++p2Seq, steer: steerVal, drift: driftVal, brake: false, boost: boostVal }, t);
      if (p2.item) useItem(race, p2, t);
    }

    stepRace(race, DT);
    if (race.phase === 'lobby') startRace(race);

    // Track completed rounds
    if (race.round > lastRound) {
      completedRounds++;
      lastRound = race.round;
    }

    // Validate sanity every 300 steps (10 seconds)
    if (step % 300 === 0) {
      const snap = snapshot(race);
      assert.ok(!Number.isNaN(p1.s), `p1.s is NaN at step ${step}`);
      assert.ok(!Number.isNaN(p2.s), `p2.s is NaN at step ${step}`);
      assert.ok(!Number.isNaN(p1.speed), `p1.speed is NaN at step ${step}`);
      assert.ok(!Number.isNaN(p2.speed), `p2.speed is NaN at step ${step}`);
      assert.ok(snap.highlights.length <= 5, 'highlights array must remain bounded <= 5');
      assert.ok(snap.entities.length <= 96, 'entities array must remain bounded');
      assert.equal(p1.human, true, 'p1 remains human seat');
      assert.equal(p2.human, true, 'p2 remains human seat');
      assert.equal(p1.connected, true, 'p1 remains connected');
      assert.equal(p2.connected, true, 'p2 remains connected');
    }
  }

  const minimumRounds = Math.max(2, Math.floor(TOTAL_SECONDS / (race.seconds + 16)));
  assert.ok(
    completedRounds >= minimumRounds,
    `Expected at least ${minimumRounds} full race rematches in 10 minutes, got ${completedRounds}`,
  );
  assert.equal(race.cars.length, 8);
  assert.equal(p1.name, '手机A');
  assert.equal(p2.name, '手机B');
});
