// Poki Duel — Gem Battle core rules (ported from the original TypeScript source).
// Pure logic, no DOM. Shared by the Worker (PokiRoom Durable Object) and the browser client.

export const SIZE = 8;
export const TURN_DAMAGE_CAP = 180;
export const TURN_HEAL_CAP = 220;
export const TURN_MANA_CAP = 35;

const gems = ['sword', 'heart', 'mana'];
const clone = (b) => b.map((r) => [...r]);
const key = (x, y) => `${x},${y}`;
const pickIndex = (length, random) => {
  const value = Number(random());
  const safe = Number.isFinite(value) ? value : 0;
  return Math.min(length - 1, Math.max(0, Math.floor(safe * length)));
};
const adjacent = (a, b) => Boolean(a && b) && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
const pick = (random) => gems[pickIndex(gems.length, random)];

function groups(board) {
  const out = [];
  for (let y = 0; y < SIZE; y++) {
    let s = 0;
    for (let x = 1; x <= SIZE; x++) {
      if (x === SIZE || board[y][x] !== board[y][s]) {
        if (x - s >= 3) out.push({ kind: board[y][s], cells: new Set(Array.from({ length: x - s }, (_, i) => key(s + i, y))) });
        s = x;
      }
    }
  }
  for (let x = 0; x < SIZE; x++) {
    let s = 0;
    for (let y = 1; y <= SIZE; y++) {
      if (y === SIZE || board[y][x] !== board[s][x]) {
        if (y - s >= 3) out.push({ kind: board[s][x], cells: new Set(Array.from({ length: y - s }, (_, i) => key(x, s + i))) });
        s = y;
      }
    }
  }
  return out;
}

function matched(board) {
  return groups(board).reduce((a, g) => { g.cells.forEach((c) => a.add(c)); return a; }, new Set());
}

function hasLineThrough(board, x, y, dx, dy) {
  const gem = board[y]?.[x];
  if (!gems.includes(gem)) return false;
  let count = 1;
  for (const direction of [-1, 1]) {
    let nextX = x + dx * direction;
    let nextY = y + dy * direction;
    while (board[nextY]?.[nextX] === gem) {
      count += 1;
      nextX += dx * direction;
      nextY += dy * direction;
    }
  }
  return count >= 3;
}

function createsMatchAt(board, point) {
  return hasLineThrough(board, point.x, point.y, 1, 0) || hasLineThrough(board, point.x, point.y, 0, 1);
}

function generate(random) {
  const b = Array.from({ length: SIZE }, () => []);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const c = gems.filter((g) => !(x > 1 && b[y][x - 1] === g && b[y][x - 2] === g) && !(y > 1 && b[y - 1][x] === g && b[y - 2][x] === g));
      b[y][x] = c[pickIndex(c.length, random)];
    }
  }
  return b;
}

export function validMoves(input) {
  const out = [];
  const board = clone(input);
  // Settled boards can only gain a new line through one of the swapped cells.
  // Keep the full scan for malformed/legacy boards that already contain a match.
  const hasExistingMatch = matched(input).size > 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const to = { x: x + dx, y: y + dy };
        if (to.x >= SIZE || to.y >= SIZE) continue;
        [board[y][x], board[to.y][to.x]] = [board[to.y][to.x], board[y][x]];
        const scores = hasExistingMatch ? matched(board).size > 0 : createsMatchAt(board, { x, y }) || createsMatchAt(board, to);
        [board[y][x], board[to.y][to.x]] = [board[to.y][to.x], board[y][x]];
        if (scores) out.push({ from: { x, y }, to });
      }
    }
  }
  return out;
}

export function createBoard(random = Math.random) {
  for (let i = 0; i < 100; i++) {
    const b = generate(random);
    if (validMoves(b).length) return b;
  }
  return generate(() => 0);
}

function collapse(board, removed, random) {
  const next = clone(board);
  for (let x = 0; x < SIZE; x++) {
    const kept = [];
    for (let y = SIZE - 1; y >= 0; y--) if (!removed.has(key(x, y))) kept.push(board[y][x]);
    let y = SIZE - 1;
    kept.forEach((g) => { next[y--][x] = g; });
    while (y >= 0) next[y--][x] = pick(random);
  }
  return next;
}

export function resolveSwap(input, from, to, random = Math.random) {
  const invalid = { valid: false, board: input, cleared: 0, damage: 0, healing: 0, mana: 0, cascades: 0, frames: [] };
  if (!adjacent(from, to) || ![from, to].every((p) => p.x >= 0 && p.x < SIZE && p.y >= 0 && p.y < SIZE)) return invalid;
  let board = clone(input);
  [board[from.y][from.x], board[to.y][to.x]] = [board[to.y][to.x], board[from.y][from.x]];
  const swappedKeys = new Set([key(from.x, from.y), key(to.x, to.y)]);
  const beforeGroups = groups(input);
  const firstGroups = groups(board);
  if (!firstGroups.some((group) => [...group.cells].some((cell) => swappedKeys.has(cell)) && !beforeGroups.some((previous) => previous.kind === group.kind && previous.cells.size === group.cells.size && [...previous.cells].every((cell) => group.cells.has(cell))))) return invalid;
  let damage = 0, healing = 0, mana = 0, cleared = 0, combo = 0;
  let primaryKind;
  const frames = [];
  while (combo < 12) {
    const found = groups(board);
    if (!found.length) break;
    combo++;
    const cells = matched(board);
    cleared += cells.size;
    if (!primaryKind) {
      const touched = new Set([key(from.x, from.y), key(to.x, to.y)]);
      primaryKind = found.find((group) => [...group.cells].some((cell) => touched.has(cell)))?.kind ?? found[0].kind;
    }
    for (const g of found) {
      if (g.kind !== primaryKind) continue;
      const n = g.cells.size * (combo === 1 ? 1 : 1.5);
      if (g.kind === 'sword') damage += Math.round(n * 55);
      if (g.kind === 'heart') healing += Math.round(n * 45);
      if (g.kind === 'mana') mana += Math.round(n * 15);
    }
    frames.push({ board: clone(board), matched: [...cells].map((c) => { const [x, y] = c.split(',').map(Number); return { x, y }; }), combo, kind: primaryKind ?? found[0].kind });
    board = collapse(board, cells, random);
  }
  if (matched(board).size || !validMoves(board).length) board = createBoard(random);
  return { valid: true, board, cleared, damage: Math.min(TURN_DAMAGE_CAP, damage), healing: Math.min(TURN_HEAL_CAP, healing), mana: Math.min(TURN_MANA_CAP, mana), cascades: combo, primaryKind, frames };
}

export const MONSTERS = {
  emberfox: { name: 'Hỏa Long', maxHp: 950, emoji: '', skill: { name: 'Pháo Viêm Ngục', damage: 220, healing: 0, manaDrain: 0, selfDamage: 0, shield: 0 } },
  mossling: { name: 'Ếch Rừng', maxHp: 1100, emoji: '', skill: { name: 'Màn Bào Tử', damage: 70, healing: 200, manaDrain: 0, selfDamage: 0, shield: 0 } },
  tidefin: { name: 'Rùa Băng', maxHp: 1150, emoji: '', skill: { name: 'Nghiền Băng Hà', damage: 130, healing: 0, manaDrain: 25, selfDamage: 0, shield: 0 } },
  voltwing: { name: 'Lôi Điểu', maxHp: 900, emoji: '', skill: { name: 'Thiên Lôi Kích', damage: 220, healing: 0, manaDrain: 0, selfDamage: 40, shield: 0 } },
  stonehorn: { name: 'Kim Xà', maxHp: 1200, emoji: '', skill: { name: 'Kim Thạch Hộ Vệ', damage: 85, healing: 0, manaDrain: 0, selfDamage: 0, shield: 200 } },
  miubeo: { name: 'Miu Béo', maxHp: 1000, emoji: '', skill: { name: 'Vồ Ánh Trăng', damage: 150, healing: 110, manaDrain: 0, selfDamage: 0, shield: 0 } },
};

export const GEM_LABEL = { sword: '⚔', heart: '♥', mana: '✦' };

export function applySpecial(monster, mana) {
  const s = MONSTERS[monster]?.skill;
  if (!s) return { valid: false, damage: 0, healing: 0, manaDrain: 0, selfDamage: 0, shield: 0, manaAfter: mana, name: 'Kỹ năng không xác định' };
  return mana < 100
    ? { valid: false, damage: 0, healing: 0, manaDrain: 0, selfDamage: 0, shield: 0, manaAfter: mana, name: s.name }
    : { valid: true, ...s, manaAfter: 0 };
}

export function initialRoom() {
  return { players: [], board: createBoard(), hp: {}, mana: {}, shield: {}, turn: 0 };
}

export function addPlayer(state, id, monster) {
  if (state.players.some((p) => p.id === id) || state.players.length >= 2) return state;
  return { ...state, players: [...state.players, { id, monster }], hp: { ...state.hp, [id]: MONSTERS[monster].maxHp }, mana: { ...state.mana, [id]: 0 }, shield: { ...state.shield, [id]: 0 } };
}

export function damageTarget(state, id, damage) {
  const safeDamage = Number.isFinite(damage) ? Math.max(0, damage) : 0;
  const shield = Number.isFinite(state.shield[id]) ? Math.max(0, state.shield[id]) : 0;
  const blocked = Math.min(shield, safeDamage);
  return { hp: Math.max(0, (state.hp[id] ?? 0) - safeDamage + blocked), shield: shield - blocked };
}

export function applyBattleDamage(state, target, damage) {
  if (state.gameOver) return { state, gameOver: true, winner: state.winner, loser: state.loser };
  if (!state.players.some((player) => player.id === target)) return { state, gameOver: false, winner: undefined, loser: undefined };
  const attacker = state.players.find((p) => p.id !== target)?.id;
  if (!attacker) return { state, gameOver: false, winner: undefined, loser: undefined };
  const hit = damageTarget(state, target, damage);
  const gameOver = hit.hp <= 0;
  return { state: { ...state, hp: { ...state.hp, [target]: hit.hp }, shield: { ...state.shield, [target]: hit.shield }, gameOver, winner: gameOver ? attacker : undefined, loser: gameOver ? target : undefined }, gameOver, winner: gameOver ? attacker : undefined, loser: gameOver ? target : undefined };
}

export function applySpecialTurn(state, attacker, mana, skill) {
  const player = state.players.find((p) => p.id === attacker);
  const target = state.players.find((p) => p.id !== attacker)?.id;
  const expected = player ? MONSTERS[player.monster]?.skill : undefined;
  if (!player || !target || state.gameOver || mana < 100 || (state.mana[attacker] ?? 0) < 100 || !skill.valid || !expected || Object.keys(expected).some((k) => skill[k] !== expected[k])) {
    return { state, gameOver: Boolean(state.gameOver), winner: state.winner, loser: state.loser };
  }
  const hit = applyBattleDamage(state, target, skill.damage);
  const maxHp = MONSTERS[player.monster].maxHp;
  const attackerHp = Math.max(0, Math.min(maxHp, (hit.state.hp[attacker] ?? maxHp) + skill.healing - skill.selfDamage));
  const attackerDead = attackerHp <= 0;
  const targetDead = hit.state.hp[target] <= 0;
  const gameOver = targetDead || attackerDead;
  const winner = targetDead ? attacker : attackerDead ? target : undefined;
  const loser = targetDead ? target : attackerDead ? attacker : undefined;
  return {
    state: {
      ...hit.state,
      hp: { ...hit.state.hp, [attacker]: attackerHp },
      mana: { ...hit.state.mana, [attacker]: 0, [target]: Math.max(0, (hit.state.mana[target] ?? 0) - skill.manaDrain) },
      shield: { ...hit.state.shield, [attacker]: Math.max(hit.state.shield[attacker] ?? 0, skill.shield) },
      gameOver, winner, loser,
    },
    gameOver, winner, loser,
  };
}
