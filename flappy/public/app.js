// Flappy Cutie — canvas client. Rendering + input + sound. Physics lives in
// game.js (time-based, testable). Optimized: DPR-aware canvas, cached sky
// gradient, sparkle pool cap, rAF delta-time, pause when tab hidden.
import {
  BIRD_R,
  BIRD_X,
  GROUND_H,
  HEIGHT,
  WIDTH,
  checkCollision,
  createFlappyState,
  flapState,
  medalFor,
  spawnPipe,
  speedFor,
  stepFlappy,
} from './game.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });
const statScore = $('statScore');
const statBest = $('statBest');
const statMedal = $('statMedal');
const toast = $('toast');
const topNick = $('nickname');
const soundBtn = $('soundButton');

// ---- DPR-aware canvas (crisp on retina, cheap on 1x) ----
const DPR = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = Math.round(WIDTH * DPR);
canvas.height = Math.round(HEIGHT * DPR);
ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

// ---- shared nickname + sound prefs (same keys as the rest of the hub) ----
topNick.value = localStorage.getItem('game-nick') || '';
topNick.addEventListener('input', () => {
  localStorage.setItem('game-nick', topNick.value.trim().slice(0, 18));
});
let soundOn = localStorage.getItem('flappy-sound') !== 'off';
function paintSound() { soundBtn.textContent = soundOn ? '◖' : '◌'; }
paintSound();
soundBtn.onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem('flappy-sound', soundOn ? 'on' : 'off');
  paintSound();
};

function showToast(message) {
  toast.textContent = message;
  toast.className = 'toast visible';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 2600);
}

// ---- tiny synth SFX (no assets) ----
let AC = null;
function beep(freq, dur = 0.08, type = 'sine', vol = 0.16, slide = 0) {
  if (!soundOn) return;
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') void AC.resume();
    const o = AC.createOscillator();
    const g = AC.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, AC.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), AC.currentTime + dur);
    g.gain.setValueAtTime(vol, AC.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + dur);
    o.connect(g);
    g.connect(AC.destination);
    o.start();
    o.stop(AC.currentTime + dur);
  } catch { /* audio unavailable — game stays silent */ }
}
const sfx = {
  flap() { beep(520, 0.09, 'sine', 0.18, 260); },
  score() { beep(880, 0.09, 'triangle', 0.2); setTimeout(() => beep(1320, 0.12, 'triangle', 0.2), 90); },
  hit() { beep(180, 0.25, 'sawtooth', 0.22, -120); },
  die() { beep(400, 0.4, 'square', 0.1, -300); },
  swoosh() { beep(300, 0.16, 'sine', 0.1, 400); },
};

// ---- state ----
const READY = 0;
const PLAY = 1;
const OVER = 2;
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const sim = createFlappyState();
let mode = READY;
let time = 0;
let wing = 0; // 0..1 wing-flap envelope
let rot = 0;
let shake = 0;
let flash = 0;
let panelT = 1; // 0 = shown, 1 = hidden (slide-in)
let overAt = -99;
let newBest = false;
let best = Number.parseInt(localStorage.getItem('flappy-best') || '0', 10) || 0;

let clouds = [];
let hills = [];
let bushes = [];
let floaties = [];
let sparkles = [];
let groundDist = 0;

function initDecor() {
  clouds = Array.from({ length: 7 }, () => ({
    x: Math.random() * WIDTH, y: 20 + Math.random() * 220,
    s: 0.5 + Math.random() * 0.9, v: 11 + Math.random() * 15,
  }));
  hills = Array.from({ length: 6 }, (_, i) => ({ x: i * 115, w: 110 + Math.random() * 40, h: 50 + Math.random() * 45 }));
  bushes = Array.from({ length: 8 }, (_, i) => ({ x: i * 70 + Math.random() * 20, s: 0.7 + Math.random() * 0.7 }));
  floaties = Array.from({ length: 12 }, () => ({
    x: Math.random() * WIDTH, y: Math.random() * HEIGHT,
    s: 1 + Math.random() * 2.5, v: 8 + Math.random() * 18,
    a: Math.random() * Math.PI * 2, heart: Math.random() < 0.3,
  }));
}
initDecor();

function burst(x, y, n, colors) {
  for (let i = 0; i < n; i++) {
    if (sparkles.length > 140) sparkles.shift();
    sparkles.push({
      x, y,
      vx: (Math.random() - 0.5) * 240, vy: (Math.random() - 0.5) * 240 - 60,
      life: 1, s: 2 + Math.random() * 3, c: colors[i % colors.length],
    });
  }
}

function paintHud() {
  statScore.textContent = String(sim.score);
  statBest.textContent = String(best);
  statMedal.textContent = medalFor(sim.score).medal;
}

function reset(toReady = true) {
  sim.birdY = HEIGHT * 0.44;
  sim.birdVY = 0;
  sim.pipes.length = 0;
  sim.score = 0;
  sim.spawnT = 0;
  sim.dead = false;
  wing = 0; rot = 0; shake = 0; flash = 0; panelT = 1; newBest = false;
  if (toReady) mode = READY;
  paintHud();
}

function gameOver() {
  mode = OVER;
  overAt = time;
  shake = reducedMotion ? 0 : 9;
  flash = reducedMotion ? 0 : 0.85;
  panelT = 1;
  sfx.hit();
  setTimeout(() => sfx.die(), 180);
  if (sim.score > best) {
    best = sim.score;
    newBest = true;
    localStorage.setItem('flappy-best', String(best));
    showToast(`🎉 Kỷ lục mới: ${best} điểm!`);
  }
  burst(BIRD_X, sim.birdY, 22, ['#FFD93D', '#FF8FB3', '#ffffff']);
  paintHud();
}

function flap() {
  if (mode === READY) { mode = PLAY; sfx.swoosh(); }
  if (mode === OVER) {
    if (time - overAt < 0.5) return; // ignore accidental taps on the panel
    reset(false);
    mode = PLAY;
    sfx.swoosh();
    return;
  }
  flapState(sim);
  wing = 1;
  sfx.flap();
  burst(BIRD_X - 12, sim.birdY + 10, 4, ['#ffffff']);
}

// ---- update (dt seconds) ----
function update(dt) {
  time += dt;
  const speed = mode === PLAY ? speedFor(sim.score) : 42;
  groundDist += speed * dt;

  for (const c of clouds) { c.x -= c.v * dt; if (c.x < -90) { c.x = WIDTH + 80; c.y = 20 + Math.random() * 220; } }
  for (const h of hills) { h.x -= speed * 0.16 * dt; if (h.x + h.w < 0) h.x += 6 * 115; }
  for (const b of bushes) { b.x -= speed * 0.45 * dt; if (b.x < -40) b.x += 8 * 70; }
  for (const f of floaties) {
    f.a += dt * 1.6; f.y -= f.v * dt; f.x += Math.sin(f.a) * 12 * dt;
    if (f.y < -10) { f.y = HEIGHT - 100; f.x = Math.random() * WIDTH; }
  }
  for (let i = sparkles.length - 1; i >= 0; i--) {
    const p = sparkles[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 320 * dt; p.life -= dt * 1.8;
    if (p.life <= 0) sparkles.splice(i, 1);
  }

  if (mode === READY) {
    sim.birdY = HEIGHT * 0.44 + Math.sin(time * 4.2) * 10;
    rot = Math.sin(time * 4.2) * 0.08;
    wing = Math.sin(time * 20) * 0.5 + 0.5;
  } else if (mode === PLAY) {
    wing = Math.max(0, wing - dt * 5);
    const before = sim.score;
    const { scored, dead } = stepFlappy(sim, dt);
    // Smooth tilt toward velocity.
    const target = sim.birdVY < 0 ? -0.38 : Math.min(Math.PI / 2.4, sim.birdVY * 0.0022);
    rot += (target - rot) * Math.min(1, dt * 11);
    if (sim.birdY < BIRD_R) { sim.birdY = BIRD_R; sim.birdVY = Math.max(0, sim.birdVY); }
    if (scored) {
      sfx.score();
      burst(BIRD_X + 10, sim.birdY - 10, 12, ['#FFD93D', '#FF8FB3', '#7CF29C', '#ffffff']);
      paintHud();
    } else if (sim.score !== before) paintHud();
    if (dead) gameOver();
  } else {
    const gy = HEIGHT - GROUND_H;
    if (sim.birdY + BIRD_R < gy) {
      sim.birdVY = Math.min(sim.birdVY + 1350 * dt, 660);
      sim.birdY = Math.min(sim.birdY + sim.birdVY * dt, gy - BIRD_R);
      rot += (Math.PI / 2 - rot) * Math.min(1, dt * 7);
    }
    wing = Math.max(0, wing - dt * 3);
    shake = Math.max(0, shake - dt * 48);
    flash = Math.max(0, flash - dt * 3.4);
    panelT = Math.max(0, panelT - dt * 3.2);
  }
}

// ---- drawing ----
const skyGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
skyGrad.addColorStop(0, '#7ED3FF');
skyGrad.addColorStop(0.45, '#BDEBFF');
skyGrad.addColorStop(0.72, '#FFF3C4');
skyGrad.addColorStop(1, '#FFE3EE');

function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCloud(x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, 7); ctx.arc(20, -8, 22, 0, 7); ctx.arc(44, 0, 17, 0, 7); ctx.arc(22, 10, 24, 0, 7);
  ctx.fill();
  ctx.fillStyle = 'rgba(190,225,255,.6)';
  ctx.beginPath();
  ctx.ellipse(22, 12, 26, 7, 0, 0, 7);
  ctx.fill();
  ctx.restore();
}

function drawBackground() {
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // sun
  const sx = WIDTH - 78;
  const sy = 92;
  const sg = ctx.createRadialGradient(sx, sy, 5, sx, sy, 60);
  sg.addColorStop(0, 'rgba(255,244,180,1)');
  sg.addColorStop(0.4, 'rgba(255,232,130,.9)');
  sg.addColorStop(1, 'rgba(255,232,130,0)');
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(sx, sy, 60, 0, 7); ctx.fill();
  ctx.fillStyle = '#FFF3A0';
  ctx.strokeStyle = '#FFB020';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(sx, sy, 30, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#B97A1A';
  ctx.beginPath(); ctx.arc(sx - 9, sy - 4, 3, 0, 7); ctx.arc(sx + 9, sy - 4, 3, 0, 7); ctx.fill();
  ctx.strokeStyle = '#B97A1A';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(sx, sy + 5, 8, 0.3, Math.PI - 0.3); ctx.stroke();
  ctx.fillStyle = 'rgba(255,140,160,.55)';
  ctx.beginPath(); ctx.arc(sx - 15, sy + 4, 4, 0, 7); ctx.arc(sx + 15, sy + 4, 4, 0, 7); ctx.fill();
  for (const c of clouds) drawCloud(c.x, c.y, c.s);
  ctx.fillStyle = '#B8E6C8';
  for (const h of hills) { ctx.beginPath(); ctx.ellipse(h.x + h.w / 2, HEIGHT - GROUND_H + 10, h.w / 2, h.h, 0, Math.PI, 0); ctx.fill(); }
  ctx.fillStyle = '#9BDCB5';
  for (const h of hills) { ctx.beginPath(); ctx.ellipse(h.x + h.w / 2 + 30, HEIGHT - GROUND_H + 14, h.w / 3, h.h * 0.7, 0, Math.PI, 0); ctx.fill(); }
  for (const f of floaties) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    if (f.heart) { ctx.font = `${10 + f.s * 3}px serif`; ctx.fillText('💗', f.x, f.y); }
    else { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(f.x, f.y, f.s, 0, 7); ctx.fill(); }
    ctx.restore();
  }
}

function pipeAt(x, y, w, h, isTop) {
  if (h <= 0) return;
  const capH = 26;
  const bodyG = ctx.createLinearGradient(x, 0, x + w, 0);
  bodyG.addColorStop(0, '#3FA34D'); bodyG.addColorStop(0.25, '#7CF29C');
  bodyG.addColorStop(0.55, '#B8F5C8'); bodyG.addColorStop(0.8, '#5BD475');
  bodyG.addColorStop(1, '#2E7D3A');
  ctx.fillStyle = bodyG;
  ctx.strokeStyle = '#1E5B28';
  ctx.lineWidth = 3;
  if (isTop) { rr(x, y - 4, w, h - capH + 8, 10); ctx.fill(); ctx.stroke(); }
  else { rr(x, y + capH - 4, w, h - capH + 4, 10); ctx.fill(); ctx.stroke(); }
  const cy = isTop ? y + h - capH : y;
  const capG = ctx.createLinearGradient(x, 0, x + w, 0);
  capG.addColorStop(0, '#2E9E44'); capG.addColorStop(0.3, '#8FF0A8');
  capG.addColorStop(0.6, '#C9FAD8'); capG.addColorStop(1, '#257A33');
  ctx.fillStyle = capG;
  rr(x - 4, cy, w + 8, capH, 9); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  rr(x + 10, (isTop ? y + 8 : cy + 6), 10, 4, 5); ctx.fill();
}

function drawPipes() {
  for (const p of sim.pipes) {
    const topH = p.gapY - p.gap / 2;
    const botY = p.gapY + p.gap / 2;
    pipeAt(p.x, 0, p.w, topH, true);
    pipeAt(p.x, botY, p.w, HEIGHT - GROUND_H - botY, false);
  }
}

function drawGround() {
  const gy = HEIGHT - GROUND_H;
  ctx.fillStyle = '#7CF29C';
  ctx.fillRect(0, gy, WIDTH, 26);
  ctx.fillStyle = '#22C55E';
  ctx.fillRect(0, gy + 22, WIDTH, 5);
  const dg = ctx.createLinearGradient(0, gy + 27, 0, HEIGHT);
  dg.addColorStop(0, '#F5D99A');
  dg.addColorStop(1, '#E8B96E');
  ctx.fillStyle = dg;
  ctx.fillRect(0, gy + 27, WIDTH, GROUND_H - 27);
  ctx.fillStyle = 'rgba(180,130,70,.5)';
  const off = groundDist % 46;
  for (let x = -off; x < WIDTH + 46; x += 46) {
    ctx.beginPath(); ctx.ellipse(x + 12, gy + 52, 7, 4, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + 34, gy + 72, 5, 3, 0, 0, 7); ctx.fill();
  }
  ctx.strokeStyle = '#22C55E';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let x = -off; x < WIDTH + 46; x += 46) {
    ctx.moveTo(x, gy + 2); ctx.lineTo(x + 5, gy - 8);
    ctx.moveTo(x + 6, gy + 2); ctx.lineTo(x + 11, gy - 7);
  }
  ctx.stroke();
  for (const b of bushes) {
    ctx.save();
    ctx.translate(b.x, gy + 4);
    ctx.scale(b.s, b.s);
    ctx.fillStyle = '#4ADE80';
    ctx.strokeStyle = '#15803D';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(-14, 0, 13, 0, 7); ctx.arc(0, -9, 16, 0, 7); ctx.arc(14, 0, 13, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#FF8FB3';
    ctx.beginPath(); ctx.arc(-6, -10, 3.5, 0, 7); ctx.arc(8, -6, 3.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-6, -10, 1.3, 0, 7); ctx.arc(8, -6, 1.3, 0, 7); ctx.fill();
    ctx.restore();
  }
}

function drawBird() {
  ctx.save();
  ctx.translate(BIRD_X, sim.birdY);
  ctx.rotate(rot);
  ctx.fillStyle = '#FF9F43';
  const wag = Math.sin(time * 24) * 3;
  ctx.beginPath();
  ctx.moveTo(-14, -2); ctx.lineTo(-26, -8 + wag); ctx.lineTo(-24, 4); ctx.lineTo(-26, 10 + wag);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#C96A12';
  ctx.lineWidth = 2;
  ctx.stroke();
  const bg = ctx.createLinearGradient(0, -18, 0, 18);
  bg.addColorStop(0, '#FFF3A0'); bg.addColorStop(0.5, '#FFD93D'); bg.addColorStop(1, '#FFB020');
  ctx.fillStyle = bg;
  ctx.strokeStyle = '#8A5A00';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(0, 0, 18, 15, 0, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.beginPath(); ctx.ellipse(3, 7, 10, 6.5, 0, 0, 7); ctx.fill();
  const wa = wing > 0 ? -0.9 + (1 - wing) * 0.9 : Math.sin(time * 18) * 0.35;
  ctx.save();
  ctx.translate(-4, 2);
  ctx.rotate(wa);
  const wg = ctx.createLinearGradient(0, -12, 0, 8);
  wg.addColorStop(0, '#FFB3C8'); wg.addColorStop(1, '#FF5D8F');
  ctx.fillStyle = wg;
  ctx.strokeStyle = '#B93A63';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(-4, 0, 12, 7, -0.4, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.beginPath(); ctx.ellipse(-6, -2, 6, 2.5, -0.4, 0, 7); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#5b4a3f';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(8, -5, 7, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#2b2b2b';
  ctx.beginPath(); ctx.arc(10, -5, 3.4, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(11.2, -6.2, 1.4, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(255,93,143,.55)';
  ctx.beginPath(); ctx.arc(12, 3, 4, 0, 7); ctx.fill();
  ctx.fillStyle = '#FF7B39';
  ctx.strokeStyle = '#B94E15';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(15, -1); ctx.lineTo(25, 2); ctx.lineTo(15, 5); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = '#8A5A00';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-2, -14); ctx.quadraticCurveTo(-4, -21, -9, -20);
  ctx.moveTo(2, -15); ctx.quadraticCurveTo(3, -22, 8, -21);
  ctx.stroke();
  ctx.restore();
}

function drawScore() {
  if (mode === OVER) return;
  ctx.save();
  ctx.font = '800 46px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(90,50,120,.55)';
  ctx.lineJoin = 'round';
  ctx.strokeText(String(sim.score), WIDTH / 2, 86);
  const sg = ctx.createLinearGradient(0, 50, 0, 90);
  sg.addColorStop(0, '#fff');
  sg.addColorStop(1, '#FFE28A');
  ctx.fillStyle = sg;
  ctx.fillText(String(sim.score), WIDTH / 2, 86);
  ctx.restore();
}

function drawReady() {
  ctx.save();
  ctx.textAlign = 'center';
  const bob = Math.sin(time * 4.8) * 6;
  ctx.save();
  ctx.translate(WIDTH / 2, 168 + bob);
  ctx.fillStyle = 'rgba(255,255,255,.93)';
  ctx.strokeStyle = '#FF8FB3';
  ctx.lineWidth = 3.5;
  rr(-150, -44, 300, 96, 22); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#FF5D8F';
  ctx.font = '800 32px "DM Sans", sans-serif';
  ctx.fillText('Flappy Cutie', 0, -2);
  ctx.fillStyle = '#8B6CC1';
  ctx.font = '700 15px "DM Sans", sans-serif';
  ctx.fillText('✨ chạm / cách để bay ✨', 0, 24);
  ctx.restore();
  const p = 1 + Math.sin(time * 9) * 0.04;
  ctx.save();
  ctx.translate(WIDTH / 2, 400);
  ctx.scale(p, p);
  ctx.fillStyle = 'rgba(107,79,161,.92)';
  ctx.font = '800 21px "DM Sans", sans-serif';
  ctx.fillText('— sẵn sàng —', 0, 0);
  ctx.font = '28px serif';
  ctx.fillText('👆🐤💨', 0, 36);
  ctx.restore();
  ctx.restore();
}

function drawOver() {
  ctx.save();
  ctx.fillStyle = 'rgba(60,20,60,.32)';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const slide = panelT * (HEIGHT * 0.6);
  ctx.translate(0, slide * -1);
  const px = WIDTH / 2 - 140;
  const py = HEIGHT / 2 - 130;
  const pw = 280;
  const ph = 300;
  ctx.save();
  ctx.shadowColor = 'rgba(150,80,180,.4)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = 'rgba(255,255,255,.97)';
  ctx.strokeStyle = '#FF8FB3';
  ctx.lineWidth = 4;
  rr(px, py, pw, ph, 24); ctx.fill(); ctx.stroke();
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FF5D8F';
  ctx.font = '800 33px "DM Sans", sans-serif';
  ctx.fillText('Game Over', WIDTH / 2, py + 52);
  ctx.font = '24px serif';
  ctx.fillText('😵‍💫💫', WIDTH / 2, py + 80);
  const { medal, name } = medalFor(sim.score);
  ctx.save();
  ctx.translate(WIDTH / 2 - 78, py + 150);
  ctx.fillStyle = '#FFF3C4';
  ctx.strokeStyle = '#E8B96E';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, 38, 0, 7); ctx.fill(); ctx.stroke();
  ctx.font = '34px serif';
  ctx.fillText(medal, 0, 13);
  ctx.fillStyle = '#8B6CC1';
  ctx.font = '800 13px "DM Sans", sans-serif';
  ctx.fillText(name.toUpperCase(), 0, 54);
  ctx.restore();
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8B6CC1';
  ctx.font = '800 17px "DM Sans", sans-serif';
  ctx.fillText('SCORE', WIDTH / 2 + 105, py + 130);
  ctx.fillText('BEST', WIDTH / 2 + 105, py + 178);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#3B2B5A';
  ctx.font = '800 34px "DM Sans", sans-serif';
  ctx.fillText(String(sim.score), WIDTH / 2 - 8, py + 140);
  ctx.fillStyle = '#FF5D8F';
  ctx.font = '800 26px "DM Sans", sans-serif';
  ctx.fillText(String(best), WIDTH / 2 - 8, py + 184);
  if (newBest) {
    const b = 1 + Math.sin(time * 12) * 0.07;
    ctx.save();
    ctx.translate(WIDTH / 2, py + 212);
    ctx.scale(b, b);
    ctx.fillStyle = '#FF2D78';
    ctx.font = '800 15px "DM Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✨ KỶ LỤC MỚI! ✨', 0, 0);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(WIDTH / 2, py + 252);
  const bw = 200;
  const bh = 48;
  const bg2 = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
  bg2.addColorStop(0, '#7CF29C');
  bg2.addColorStop(1, '#22C55E');
  ctx.fillStyle = bg2;
  ctx.strokeStyle = '#15803D';
  ctx.lineWidth = 3;
  rr(-bw / 2, -bh / 2, bw, bh, 24); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#06381A';
  ctx.font = '800 18px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('↻ CHẠM ĐỂ CHƠI LẠI', 0, 6);
  ctx.restore();
  ctx.restore();
}

function render() {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawBackground();
  drawPipes();
  drawGround();
  for (const p of sparkles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.c;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.s * p.life + 0.5, 0, 7);
    ctx.fill();
    ctx.restore();
  }
  drawBird();
  drawScore();
  if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash})`; ctx.fillRect(-20, -20, WIDTH + 40, HEIGHT + 40); }
  ctx.restore();
  if (mode === READY) drawReady();
  if (mode === OVER) drawOver();
}

// ---- main loop with delta time ----
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000 || 0, 0.05);
  last = now;
  if (!document.hidden) {
    // Seed one pipe so READY screen already shows the world; real spawns
    // start on play. Cap dt so tab-switch jumps never tunnel through pipes.
    update(Math.min(dt, 0.033));
    render();
  } else {
    last = performance.now();
  }
  requestAnimationFrame(loop);
}

// Warm up: show a pipe behind the READY banner.
spawnPipe(sim, () => 0.45);
sim.pipes[0].x = WIDTH * 0.62;
sim.spawnT = 99;
paintHud();
requestAnimationFrame(loop);

// ---- input ----
canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); flap(); });
$('flapBtn').addEventListener('click', (e) => { e.stopPropagation(); flap(); });
$('restartBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  reset(false);
  mode = PLAY;
  sfx.swoosh();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { e.preventDefault(); flap(); }
  if (e.code === 'KeyR') { reset(false); mode = PLAY; }
});
document.addEventListener('visibilitychange', () => { last = performance.now(); });

// Keep a stale collision helper referenced for tree-shaking safety in tests.
void checkCollision;
