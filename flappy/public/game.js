// Flappy Cutie — pure game logic (no DOM). Time-based (seconds) so the game
// feels identical on 60Hz / 120Hz screens. Imported by the canvas client and
// by node tests.
//
// Units: pixels, seconds. Original frame-based tuning (60fps):
// gravity 0.36/f, flap -6.4/f, speed 2.2/f  →  converted below.

export const WIDTH = 420;
export const HEIGHT = 640;
export const GROUND_H = 92;
export const BIRD_X = 110;
export const BIRD_R = 16;
export const BIRD_START_Y = Math.round(HEIGHT * 0.44);

export const GRAVITY = 1350; // px/s^2
export const FLAP_VY = -420; // px/s
export const MAX_FALL = 660; // px/s clamp

export const SPEED_BASE = 135; // px/s
export const SPEED_PER_SCORE = 2.8;
export const SPEED_MAX = 255;

export const GAP_BASE = 152;
export const GAP_PER_SCORE = 1.3;
export const GAP_MIN = 118;

export const PIPE_W = 68;
export const SPAWN_BASE = 1.65; // seconds between pipes
export const SPAWN_PER_SCORE = 0.018;
export const SPAWN_MIN = 1.2;

export const MAX_DT = 1 / 30; // clamp huge tab-switch jumps

export function speedFor(score) {
  const s = Math.max(0, Number(score) || 0);
  return Math.min(SPEED_BASE + s * SPEED_PER_SCORE, SPEED_MAX);
}

export function gapFor(score) {
  const s = Math.max(0, Number(score) || 0);
  return Math.max(GAP_BASE - s * GAP_PER_SCORE, GAP_MIN);
}

export function spawnIntervalFor(score) {
  const s = Math.max(0, Number(score) || 0);
  return Math.max(SPAWN_BASE - s * SPAWN_PER_SCORE, SPAWN_MIN);
}

export function createFlappyState() {
  return {
    birdY: BIRD_START_Y,
    birdVY: 0,
    pipes: [],
    score: 0,
    spawnT: 0,
    dead: false,
  };
}

export function flapState(state) {
  state.birdVY = FLAP_VY;
  state.dead = false;
  return state;
}

export function spawnPipe(state, rng = Math.random) {
  const gap = gapFor(state.score);
  const margin = 70;
  const minY = margin + gap / 2;
  const maxY = HEIGHT - GROUND_H - margin - gap / 2;
  const rand = typeof rng === 'function' ? rng() : 0.5;
  const safe = Number.isFinite(rand) ? Math.min(Math.max(rand, 0), 1) : 0.5;
  const gapY = minY + safe * Math.max(0, maxY - minY);
  const pipe = { x: WIDTH + 20, w: PIPE_W, gapY, gap, passed: false };
  state.pipes.push(pipe);
  return pipe;
}

export function circleHitsRect(cx, cy, r, rx, ry, rw, rh) {
  if (rw <= 0 || rh <= 0) return false;
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

export function checkCollision(state) {
  const groundY = HEIGHT - GROUND_H;
  if (state.birdY + BIRD_R >= groundY) return true;
  // Flying above the screen is forgiven (client clamps), never a death.
  for (const p of state.pipes) {
    const topH = p.gapY - p.gap / 2;
    const botY = p.gapY + p.gap / 2;
    const r = BIRD_R - 2;
    if (circleHitsRect(BIRD_X, state.birdY, r, p.x, -60, p.w, topH + 60)) return true;
    if (circleHitsRect(BIRD_X, state.birdY, r, p.x, botY, p.w, groundY - botY)) return true;
  }
  return false;
}

// Advance the simulation by dt seconds. Mutates `state`, returns events.
// Pass rng for deterministic pipe spawns in tests.
export function stepFlappy(state, dt, rng = Math.random) {
  const h = Math.min(Math.max(Number(dt) || 0, 0), MAX_DT);
  const speed = speedFor(state.score);

  state.birdVY = Math.min(state.birdVY + GRAVITY * h, MAX_FALL);
  state.birdY += state.birdVY * h;

  for (const p of state.pipes) p.x -= speed * h;
  while (state.pipes.length && state.pipes[0].x + state.pipes[0].w < -30) state.pipes.shift();

  state.spawnT -= h;
  if (state.spawnT <= 0) {
    spawnPipe(state, rng);
    state.spawnT = spawnIntervalFor(state.score);
  }

  let scored = 0;
  for (const p of state.pipes) {
    if (!p.passed && p.x + p.w < BIRD_X - BIRD_R) {
      p.passed = true;
      state.score += 1;
      scored += 1;
    }
  }

  state.dead = checkCollision(state);
  return { scored, dead: state.dead };
}

export function medalFor(score) {
  const s = Math.max(0, Number(score) || 0);
  if (s >= 30) return { medal: '💎', name: 'Platinum' };
  if (s >= 20) return { medal: '🥇', name: 'Gold' };
  if (s >= 10) return { medal: '🥈', name: 'Silver' };
  if (s >= 5) return { medal: '🥉', name: 'Bronze' };
  return { medal: '🌱', name: 'Sprout' };
}
