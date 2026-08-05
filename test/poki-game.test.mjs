import test from 'node:test';
import assert from 'node:assert/strict';
import { addPlayer, applyBattleDamage, applySpecial, applySpecialTurn, canClaimPlayerConnection, createBoard, damageTarget, initialRoom, MONSTERS, resolveSwap, validMoves } from '../poki/public/game.js';

const GEMS = ['sword', 'heart', 'mana'];

function boardFor(target) {
  const otherA = target === 'sword' ? 'heart' : 'sword';
  const otherB = target === 'mana' ? 'heart' : 'mana';
  const pattern = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ((x + y) % 2 ? otherA : otherB)));
  pattern[0][0] = target; pattern[0][1] = otherA; pattern[0][2] = target;
  pattern[1][1] = target;
  return pattern;
}

function pair() {
  return addPlayer(addPlayer(initialRoom(), 'player-a', 'emberfox'), 'player-b', 'stonehorn');
}

test('creates an 8x8 board containing only sword, heart, and mana gems', () => {
  const board = createBoard();
  assert.equal(board.length, 8);
  assert.ok(board.flat().every((gem) => GEMS.includes(gem)));
  assert.ok(validMoves(board).length > 0);
});

test('keeps board generation valid when the random source returns its upper boundary', () => {
  const board = createBoard(() => 1);
  assert.ok(board.flat().every((gem) => GEMS.includes(gem)));
  assert.ok(validMoves(board).length > 0);
});

test('sword matches deal damage without healing or mana', () => {
  const result = resolveSwap(boardFor('sword'), { x: 1, y: 0 }, { x: 1, y: 1 }, () => 0.1);
  assert.equal(result.valid, true);
  assert.ok(result.damage > 0);
  assert.ok(result.damage <= 180);
  assert.equal(result.frames[0].kind, 'sword');
  assert.equal(result.mana, 0);
});

test('a six-gem sword chain cannot one-shot a 1000 HP player', () => {
  const six = resolveSwap(boardFor('sword'), { x: 1, y: 0 }, { x: 1, y: 1 }, () => 0.01);
  assert.ok(six.damage <= 180);
  assert.ok(six.damage < 1000);
});

test('heart matches heal without damage or mana', () => {
  const result = resolveSwap(boardFor('heart'), { x: 1, y: 0 }, { x: 1, y: 1 }, () => 0.1);
  assert.equal(result.valid, true);
  assert.ok(result.healing > 0);
  assert.ok(result.healing <= 220);
  assert.equal(result.damage, 0);
  assert.equal(result.mana, 0);
  assert.equal(result.frames[0].kind, 'heart');
});

test('mana matches charge energy without damage or healing', () => {
  const result = resolveSwap(boardFor('mana'), { x: 1, y: 0 }, { x: 1, y: 1 }, () => 0.1);
  assert.equal(result.valid, true);
  assert.ok(result.mana > 0);
  assert.ok(result.mana <= 35);
  assert.equal(result.damage, 0);
  assert.equal(result.healing, 0);
});

test('rejects a swap that only reprocesses an already existing touched match', () => {
  const board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ((x + y) % 2 ? 'heart' : 'mana')));
  board[0][0] = 'sword'; board[0][1] = 'sword'; board[0][2] = 'sword';
  const result = resolveSwap(board, { x: 0, y: 0 }, { x: 1, y: 0 }, () => 0.1);
  assert.equal(result.valid, false);
  assert.deepEqual(result.board, board);
});

test('rejects a non-scoring swap even when another match already exists elsewhere', () => {
  const board = Array.from({ length: 8 }, () => Array(8).fill('mana'));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) board[y][x] = (x + y) % 2 ? 'heart' : 'mana';
  board[6][0] = 'sword'; board[6][1] = 'sword'; board[6][2] = 'sword';
  board[0][0] = 'heart'; board[0][1] = 'mana';
  const result = resolveSwap(board, { x: 0, y: 0 }, { x: 1, y: 0 }, () => 0.1);
  assert.equal(result.valid, false);
  assert.equal(result.damage, 0);
  assert.equal(result.healing, 0);
  assert.equal(result.mana, 0);
});

test('returns a stable board when a refill would keep creating cascades', () => {
  const board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ((x + y) % 2 ? 'heart' : 'mana')));
  board[0][0] = 'sword'; board[0][1] = 'heart'; board[0][2] = 'sword'; board[1][1] = 'sword';
  const result = resolveSwap(board, { x: 1, y: 0 }, { x: 1, y: 1 }, () => 0.1);
  assert.equal(result.valid, true);
  const stable = result.board;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const gem = stable[y][x];
      assert.ok(!(x < 6 && gem === stable[y][x + 1] && gem === stable[y][x + 2]));
      assert.ok(!(y < 6 && gem === stable[y + 1][x] && gem === stable[y + 2][x]));
    }
  }
});

test('starts each chosen creature at its own HP and 0 Mana', () => {
  const room = addPlayer(initialRoom(), 'player-a', 'emberfox');
  assert.deepEqual(room.players[0], { id: 'player-a', monster: 'emberfox' });
  assert.equal(room.hp['player-a'], MONSTERS.emberfox.maxHp);
  assert.equal(new Set(Object.values(MONSTERS).map((monster) => monster.maxHp)).size, 6);
  assert.equal(room.mana['player-a'], 0);
});

test('offers six original creatures with distinct special skills', () => {
  assert.equal(Object.keys(MONSTERS).length, 6);
  assert.equal(MONSTERS.miubeo.name, 'Miu Béo');
  assert.equal(MONSTERS.miubeo.skill.name, 'Vồ Ánh Trăng');
  assert.equal(new Set(Object.values(MONSTERS).map((monster) => monster.skill.name)).size, 6);
});

test('requires 100 Mana and gives every creature a distinct special result', () => {
  assert.equal(applySpecial('emberfox', 99).valid, false);
  const skills = Object.keys(MONSTERS).map((id) => applySpecial(id, 100));
  assert.ok(skills.every((skill) => skill.valid && skill.manaAfter === 0));
  assert.equal(new Set(skills.map((skill) => JSON.stringify(skill))).size, 6);
  assert.ok(skills.every((skill) => skill.damage <= 220 && skill.healing <= 200 && skill.shield <= 200 && skill.selfDamage <= 40 && skill.manaDrain <= 25));
  assert.deepEqual(MONSTERS.emberfox.skill, { name: 'Pháo Viêm Ngục', damage: 220, healing: 0, manaDrain: 0, selfDamage: 0, shield: 0 });
});

test('declares the defender defeated when damage reduces HP to zero', () => {
  const room = pair();
  const result = applyBattleDamage(room, 'player-b', MONSTERS.stonehorn.maxHp);
  assert.equal(result.gameOver, true);
  assert.equal(result.winner, 'player-a');
  assert.equal(result.loser, 'player-b');
  assert.equal(result.state.hp['player-b'], 0);
});

test('does not let negative damage increase a shield', () => {
  const room = { ...pair(), shield: { ...pair().shield, 'player-b': 50 } };
  const result = damageTarget(room, 'player-b', -10);
  assert.equal(result.hp, MONSTERS.stonehorn.maxHp);
  assert.equal(result.shield, 50);
});

test('treats non-finite damage as zero damage', () => {
  const room = { ...pair(), shield: { ...pair().shield, 'player-b': 50 } };
  const result = damageTarget(room, 'player-b', Number.NaN);
  assert.equal(result.hp, MONSTERS.stonehorn.maxHp);
  assert.equal(result.shield, 50);
});

test('ignores battle damage addressed to a player outside the room', () => {
  const room = pair();
  const result = applyBattleDamage(room, 'forged-player', 1000);
  assert.equal(result.gameOver, false);
  assert.deepEqual(result.state, room);
});

test('does not finish a one-player room when damage has no attacker', () => {
  const room = addPlayer(initialRoom(), 'player-a', 'emberfox');
  const result = applyBattleDamage(room, 'player-a', MONSTERS.emberfox.maxHp);
  assert.equal(result.gameOver, false);
  assert.deepEqual(result.state, room);
});

test('does not allow battle damage after the match is over', () => {
  const room = pair();
  const ended = applyBattleDamage(room, 'player-b', MONSTERS.stonehorn.maxHp).state;
  const again = applyBattleDamage(ended, 'player-a', 1000);
  assert.equal(again.gameOver, true);
  assert.equal(again.state.hp['player-a'], MONSTERS.emberfox.maxHp);
  assert.equal(again.winner, 'player-a');
});

test('keeps the attacker as winner when a special also deals recoil damage', () => {
  const base = addPlayer(addPlayer(initialRoom(), 'player-a', 'voltwing'), 'player-b', 'stonehorn');
  const room = { ...base, hp: { ...base.hp, 'player-a': 100, 'player-b': 200 }, mana: { ...base.mana, 'player-a': 100 } };
  const result = applySpecialTurn(room, 'player-a', 100, applySpecial('voltwing', 100));
  assert.equal(result.state.gameOver, true);
  assert.equal(result.state.winner, 'player-a');
  assert.equal(result.state.loser, 'player-b');
});

test('a room holds at most two players', () => {
  const room = addPlayer(addPlayer(initialRoom(), 'player-a', 'emberfox'), 'player-b', 'stonehorn');
  const third = addPlayer(room, 'player-c', 'miubeo');
  assert.deepEqual(third, room);
  assert.equal(third.players.length, 2);
});

test('connection identity prevents claiming an existing player', () => {
  assert.equal(canClaimPlayerConnection(['player-a'], 'player-a'), false);
  assert.equal(canClaimPlayerConnection(['player-a'], 'player-b'), true);
  assert.equal(canClaimPlayerConnection(['player-a'], 'player-a', 'player-a'), true);
  assert.equal(canClaimPlayerConnection(['player-a'], 'player-b', 'player-a'), false);
});
