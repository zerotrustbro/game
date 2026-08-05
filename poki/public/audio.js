// Poki Duel — procedural audio (Web Audio API). Ported from the original TypeScript source.

let context;
let enabled = localStorage.getItem('poki-sound') !== 'off';
let lastVoice = 0;

const ctx = () => context ??= new AudioContext();
const now = () => ctx().currentTime;

export function unlockAudio() {
  if (!enabled) return;
  void ctx().resume().catch(() => undefined);
}

function tone(frequency, duration, type = 'sine', volume = 0.08, delay = 0, endFrequency) {
  if (!enabled) return;
  const audio = ctx();
  const start = now() + delay;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function noise(duration, volume = 0.05, delay = 0, highpass = 0) {
  if (!enabled) return;
  const audio = ctx();
  const start = now() + delay;
  const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * duration), audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const source = audio.createBufferSource();
  const gain = audio.createGain();
  source.buffer = buffer;
  if (highpass) {
    const filter = audio.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    source.connect(filter).connect(gain);
  } else {
    source.connect(gain);
  }
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  gain.connect(audio.destination);
  source.start(start);
}

export function soundEnabled() { return enabled; }
export function setSoundEnabled(value) {
  enabled = value;
  localStorage.setItem('poki-sound', value ? 'on' : 'off');
  if (value) { unlockAudio(); tone(660, 0.08, 'sine', 0.05); tone(880, 0.12, 'sine', 0.04, 0.07); }
}

export function creatureVoice(monster, force = false) {
  if (!enabled) return;
  const stamp = performance.now();
  if (!force && stamp - lastVoice < 280) return;
  lastVoice = stamp;
  unlockAudio();
  switch (monster) {
    case 'emberfox': tone(105, 0.32, 'sawtooth', 0.09, 0, 62); tone(73, 0.42, 'square', 0.04, 0.13, 48); noise(0.35, 0.055, 0.04, 180); break;
    case 'mossling': tone(125, 0.14, 'sine', 0.09, 0, 88); tone(103, 0.18, 'sine', 0.09, 0.17, 68); tone(720, 0.22, 'sine', 0.025, 0.12, 470); break;
    case 'tidefin': tone(155, 0.42, 'triangle', 0.075, 0, 82); tone(930, 0.3, 'sine', 0.03, 0.08, 510); noise(0.28, 0.035, 0.08, 700); break;
    case 'voltwing': tone(970, 0.1, 'sawtooth', 0.055, 0, 1480); tone(1220, 0.12, 'square', 0.04, 0.11, 760); noise(0.24, 0.06, 0.04, 1800); break;
    case 'stonehorn': tone(74, 0.5, 'sawtooth', 0.08, 0, 42); tone(116, 0.18, 'square', 0.035, 0.09, 72); noise(0.38, 0.065, 0.04, 90); break;
    case 'miubeo': tone(410, 0.12, 'sine', 0.065, 0, 530); tone(550, 0.24, 'triangle', 0.055, 0.1, 340); tone(270, 0.14, 'sine', 0.025, 0.29, 220); break;
  }
}

export function attackSound(monster, special = false) {
  if (!enabled) return;
  unlockAudio();
  creatureVoice(monster, true);
  const delay = special ? 0.28 : 0.2;
  noise(special ? 0.42 : 0.22, special ? 0.09 : 0.055, delay, special ? 500 : 1000);
  tone(special ? 180 : 280, special ? 0.42 : 0.18, 'sawtooth', special ? 0.085 : 0.05, delay, special ? 55 : 120);
  if (special) { tone(520, 0.34, 'triangle', 0.055, 0.18, 1120); tone(1040, 0.3, 'sine', 0.04, 0.38, 250); }
}

export function rewardSound(kind) {
  if (!enabled) return;
  unlockAudio();
  if (kind === 'heal') { tone(440, 0.16, 'sine', 0.045); tone(660, 0.18, 'sine', 0.045, 0.1); tone(880, 0.22, 'sine', 0.04, 0.2); }
  else { tone(320, 0.13, 'triangle', 0.04); tone(480, 0.18, 'triangle', 0.045, 0.09); tone(720, 0.25, 'sine', 0.04, 0.18); }
}

export function defeatSound(won) {
  if (!enabled) return;
  unlockAudio();
  if (won) { tone(392, 0.2, 'triangle', 0.05); tone(523, 0.2, 'triangle', 0.05, 0.16); tone(784, 0.4, 'triangle', 0.06, 0.32); }
  else { tone(260, 0.25, 'sawtooth', 0.045, 0, 180); tone(180, 0.45, 'triangle', 0.055, 0.2, 75); }
}
