import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIRD_R,
  BIRD_X,
  FLAP_VY,
  GRAVITY,
  HEIGHT,
  checkCollision,
  createFlappyState,
  flapState,
  gapFor,
  medalFor,
  spawnIntervalFor,
  spawnPipe,
  speedFor,
  stepFlappy,
} from '../flappy/public/game.js';

test('flap gives an upward velocity, gravity pulls back down', () => {
  const s = createFlappyState();
  flapState(s);
  assert.equal(s.birdVY, FLAP_VY);
  const y0 = s.birdY;
  stepFlappy(s, 0.05, () => 0.5);
  assert.ok(s.birdVY > FLAP_VY, 'gravity should reduce upward speed');
  assert.ok(s.birdY < y0, 'bird should still be rising right after a flap');
  // Let it fall for a while: velocity must grow toward the fall clamp.
  for (let i = 0; i < 120; i++) stepFlappy(s, 1 / 60, () => 0.5);
  assert.ok(s.birdVY > 0, 'bird must be falling after a while');
});

test('difficulty ramps: faster pipes, tighter gaps, capped', () => {
  assert.ok(speedFor(20) > speedFor(0));
  assert.equal(speedFor(9999) <= 255, true);
  assert.ok(gapFor(20) < gapFor(0));
  assert.equal(gapFor(9999) >= 118, true);
  assert.ok(spawnIntervalFor(20) < spawnIntervalFor(0));
  assert.equal(spawnIntervalFor(9999) >= 1.2, true);
});

test('passing a pipe scores exactly once', () => {
  const s = createFlappyState();
  s.spawnT = 99; // no auto-spawn during this step
  s.pipes.push({ x: BIRD_X - BIRD_R - 68 - 1, w: 68, gapY: s.birdY, gap: 200, passed: false });
  const { scored } = stepFlappy(s, 1 / 60, () => 0.5);
  assert.equal(scored, 1);
  assert.equal(s.score, 1);
  const again = stepFlappy(s, 1 / 60, () => 0.5);
  assert.equal(again.scored, 0, 'same pipe must not score twice');
});

test('pipe spawn stays inside playable bounds even with hostile rng', () => {
  for (const rng of [() => 0, () => 1, () => NaN, () => Infinity]) {
    const s = createFlappyState();
    const p = spawnPipe(s, rng);
    assert.ok(Number.isFinite(p.gapY));
    assert.ok(p.gapY - p.gap / 2 >= 60);
    assert.ok(p.gapY + p.gap / 2 <= HEIGHT - 92 - 60);
  }
});

test('collision: ground and pipes kill, open gap does not', () => {
  const ground = createFlappyState();
  ground.birdY = HEIGHT; // under the ground line
  assert.equal(checkCollision(ground), true);

  const open = createFlappyState();
  open.spawnT = 99;
  open.pipes.push({ x: BIRD_X - 10, w: 68, gapY: open.birdY, gap: 400, passed: false });
  assert.equal(checkCollision(open), false);

  const wall = createFlappyState();
  wall.spawnT = 99;
  wall.pipes.push({ x: BIRD_X - 10, w: 68, gapY: open.birdY + 300, gap: 80, passed: false });
  assert.equal(checkCollision(wall), true);
  assert.ok(BIRD_R > 0 && BIRD_X > 0);
  void GRAVITY;
});

test('medal tiers match the HUD labels', () => {
  assert.deepEqual(medalFor(0), { medal: '🌱', name: 'Sprout' });
  assert.deepEqual(medalFor(7), { medal: '🥉', name: 'Bronze' });
  assert.deepEqual(medalFor(15), { medal: '🥈', name: 'Silver' });
  assert.deepEqual(medalFor(25), { medal: '🥇', name: 'Gold' });
  assert.deepEqual(medalFor(40), { medal: '💎', name: 'Platinum' });
});
