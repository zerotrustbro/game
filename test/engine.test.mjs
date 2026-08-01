import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canBeat,
  createGame,
  dealGame,
  describeCombo,
  passMove,
  playMove,
} from '../tienlen/public/engine.js';

const gameWith = (hands, options = {}) => createGame(
  hands.map((hand, index) => ({ id: String.fromCharCode(97 + index), hand })),
  options,
);

test('classifies the core Tiến Lên combinations', () => {
  assert.equal(describeCombo(['3s']).type, 'single');
  assert.equal(describeCombo(['4s', '4h']).type, 'pair');
  assert.equal(describeCombo(['5s', '5c', '5d']).type, 'triple');
  assert.equal(describeCombo(['6s', '7c', '8d']).type, 'straight');
  assert.equal(describeCombo(['9s', '9c', '9d', '9h']).type, 'four');
  assert.equal(describeCombo(['3s', '3c', '4s', '4c', '5s', '5c']).type, 'pairseq');
});

test('first play must include three of spades', () => {
  const game = gameWith([['4s', '5s'], ['3s', '6s']], { mustStart: true, turnIndex: 0 });
  const result = playMove(game, 'a', ['4s']);
  assert.equal(result.ok, false);
  assert.match(result.error, /3 bích/);
});

test('deals exactly thirteen cards to each player', () => {
  const game = gameWith([[], []]);
  const dealt = dealGame(game.players, () => 0.5);
  assert.equal(dealt.players[0].hand.length, 13);
  assert.equal(dealt.players[1].hand.length, 13);
  assert.equal(new Set(dealt.players.flatMap((player) => player.hand)).size, 26);
});

test('plays only owned cards, advances the turn, and removes cards', () => {
  const game = gameWith([['3s', '4s'], ['5s']], { mustStart: true });
  const result = playMove(game, 'a', ['3s']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.game.players[0].hand, ['4s']);
  assert.equal(result.game.turnIndex, 1);
  assert.equal(result.game.currentPlay.playerId, 'a');

  const notOwned = playMove(result.game, 'b', ['4s']);
  assert.equal(notOwned.ok, false);
  assert.match(notOwned.error, /không sở hữu/);
});

test('a three-card straight beats a lower three-card straight', () => {
  const previous = describeCombo(['4s', '5c', '6d']);
  const higher = describeCombo(['7s', '8c', '9d']);
  const lower = describeCombo(['3s', '4c', '5d']);
  assert.equal(canBeat(higher, previous), true);
  assert.equal(canBeat(lower, previous), false);
});

test('a four of a kind or three consecutive pairs cuts a single two', () => {
  const two = describeCombo(['2h']);
  assert.equal(canBeat(describeCombo(['7s', '7c', '7d', '7h']), two), true);
  assert.equal(canBeat(describeCombo(['3s', '3c', '4s', '4c', '5s', '5c']), two), true);
  assert.equal(canBeat(describeCombo(['A s'.replace(' ', '')]), two), false);
});

test('passing around the table resets the trick to the last player', () => {
  const game = gameWith([['3s', '4s'], ['5s'], ['6s']], { mustStart: true });
  const played = playMove(game, 'a', ['3s']);
  assert.equal(played.ok, true);
  const passB = passMove(played.game, 'b');
  assert.equal(passB.ok, true);
  const passC = passMove(passB.game, 'c');
  assert.equal(passC.ok, true);
  assert.equal(passC.game.currentPlay, null);
  assert.equal(passC.game.turnIndex, 0);
});

test('winning with the last card produces terminal state', () => {
  const game = gameWith([['3s'], ['4s']], { mustStart: true });
  const result = playMove(game, 'a', ['3s']);
  assert.equal(result.ok, true);
  assert.equal(result.game.gameOver, true);
  assert.equal(result.game.winner, 'a');
  assert.equal(result.game.turnIndex, 0);
});

test('rejects a move after game over', () => {
  const game = gameWith([['3s'], ['4s']], { mustStart: true });
  const finished = playMove(game, 'a', ['3s']);
  const result = playMove(finished.game, 'b', ['4s']);
  assert.equal(result.ok, false);
  assert.match(result.error, /kết thúc/);
});
