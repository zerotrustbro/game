import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { XoRoom } from '../worker/index.js';
import { addPlayer, emptyBoard, initialGame, makeMove, restartGame } from '../xo/public/game.js';

function createSocket() {
  return {
    messages: [],
    send(message) {
      this.messages.push(JSON.parse(message));
    },
  };
}

function createXoRoom(saved = undefined) {
  let persisted = saved;
  const room = new XoRoom({
    storage: {
      async get() {
        return persisted;
      },
      async put(key, value) {
        persisted = structuredClone(value);
      },
    },
  }, {});
  room.getPersisted = () => persisted;
  return room;
}

async function xoRoom(saved) {
  const room = createXoRoom(saved);
  await room.ready;
  return room;
}

function session(id, name = id) {
  return { socket: createSocket(), id, name };
}

const last = (item) => item.socket.messages.at(-1);

// ---- core rules ----

test('first player is X, second is O, with fresh empty board', () => {
  const game = addPlayer(addPlayer(initialGame(), { id: 'a' }), { id: 'b' });
  assert.equal(game.players[0].symbol, 'X');
  assert.equal(game.players[1].symbol, 'O');
  assert.deepEqual(game.board, emptyBoard());
});

test('a room holds at most two players', () => {
  const game = addPlayer(addPlayer(initialGame(), { id: 'a' }), { id: 'b' });
  assert.deepEqual(addPlayer(game, { id: 'c' }), game);
});

test('moves alternate and reject occupied cells or out-of-turn plays', () => {
  const game = addPlayer(addPlayer(initialGame(), { id: 'a' }), { id: 'b' });
  const first = makeMove(game, 'a', 0);
  assert.equal(first.ok, true);
  assert.equal(first.game.board[0], 'X');
  assert.equal(first.game.turn, 1);

  const outOfTurn = makeMove(first.game, 'a', 1);
  assert.equal(outOfTurn.ok, false);
  assert.match(outOfTurn.error, /lượt/);

  const occupied = makeMove(first.game, 'b', 0);
  assert.equal(occupied.ok, false);
  assert.match(occupied.error, /đã được đánh/);

  const second = makeMove(first.game, 'b', 1);
  assert.equal(second.ok, true);
  assert.equal(second.game.board[1], 'O');
});

test('three in a row declares a winner', () => {
  let game = addPlayer(addPlayer(initialGame(), { id: 'a' }), { id: 'b' });
  // a: 0,4,8 → diagonal; b fills 1,2 in between
  for (const [player, cell] of [['a', 0], ['b', 1], ['a', 4], ['b', 2], ['a', 8]]) {
    const result = makeMove(game, player, cell);
    assert.equal(result.ok, true);
    game = result.game;
  }
  assert.equal(game.gameOver, true);
  assert.equal(game.winner, 'a');
  assert.equal(game.draw, false);
});

test('a full board with no line is a draw', () => {
  let game = addPlayer(addPlayer(initialGame(), { id: 'a' }), { id: 'b' });
  //  X O X
  //  X O O
  //  O X X   — 9 moves, no three-in-a-row for either side
  const cells = [0, 1, 2, 4, 3, 5, 7, 6, 8];
  for (let i = 0; i < cells.length; i++) {
    const result = makeMove(game, i % 2 === 0 ? 'a' : 'b', cells[i]);
    assert.equal(result.ok, true);
    game = result.game;
  }
  assert.equal(game.gameOver, true);
  assert.equal(game.draw, true);
  assert.equal(game.winner, null);
});

test('restart resets the board and keeps both players', () => {
  const game = addPlayer(addPlayer(initialGame(), { id: 'a' }), { id: 'b' });
  const played = makeMove(game, 'a', 0).game;
  const again = restartGame({ ...played, gameOver: true, winner: 'a' });
  assert.deepEqual(again.board, emptyBoard());
  assert.equal(again.turn, 0);
  assert.equal(again.players.length, 2);
  assert.ok(!again.gameOver);
});

// ---- XoRoom ----

test('xo room summary starts empty, joinable, and without a finished match', async () => {
  const room = await xoRoom();
  assert.deepEqual(room.summary(), {
    code: 'XO??', players: 0, maxPlayers: 2, phase: 'waiting', canJoin: true, gameOver: false,
  });
});

test('xo room accepts exactly two players and rejects a third', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  const carol = session('player-carol', 'Carol');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });
  await room.join(carol, { id: 'player-carol', name: 'Carol' });

  assert.equal(room.game.players.length, 2);
  assert.equal(last(carol).type, 'error');
  assert.equal(last(carol).fatal, true);
  assert.match(last(carol).message, /đủ 2 người/);
  assert.equal(room.game.players[0].symbol, 'X');
  assert.equal(room.game.players[1].symbol, 'O');
});

test('a stale offline waiting seat is replaced by the next player', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  room.game.players[0].connected = false;
  assert.equal(room.summary().canJoin, true);
  const bob = session('player-bob', 'Bob');
  await room.join(bob, { id: 'player-bob', name: 'Bob' });
  assert.deepEqual(room.game.players.map((player) => player.id), ['player-bob']);
});

test('xo moves require the active player and a free cell', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });

  await room.move(bob, { cell: 0 });
  assert.equal(last(bob).type, 'error');
  assert.match(last(bob).message, /lượt/);

  await room.move(alice, { cell: 0 });
  assert.equal(room.game.board[0], 'X');
  assert.equal(room.game.turn, 1);

  await room.move(bob, { cell: 0 });
  assert.equal(last(bob).type, 'error');
  assert.match(last(bob).message, /đã được đánh/);

  await room.move(bob, { cell: 1 });
  assert.equal(room.game.board[1], 'O');
});

test('xo room ends the match on a line and allows restart', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });

  for (const [player, cell] of [['player-alice', 0], ['player-bob', 3], ['player-alice', 4], ['player-bob', 5], ['player-alice', 8]]) {
    await room.move(player === 'player-alice' ? alice : bob, { cell });
  }

  assert.equal(room.game.gameOver, true);
  assert.equal(room.game.winner, 'player-alice');

  await room.restart(bob);
  assert.ok(!room.game.gameOver);
  assert.deepEqual(room.game.board, emptyBoard());
  assert.equal(room.game.players.length, 2);
});

test('xo leave frees the seat and resets for the remaining player', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });

  await room.leave(alice);

  assert.equal(room.game.players.length, 1);
  assert.equal(room.game.players[0].id, 'player-bob');
  assert.ok(!room.game.gameOver);

  const carol = session('player-carol', 'Carol');
  await room.join(carol, { id: 'player-carol', name: 'Carol' });
  assert.equal(room.game.players.length, 2);
});

test('an xo table where everyone disconnected resets for newcomers', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });
  room.game.players.forEach((player) => { player.connected = false; });

  room.onClose(alice);
  await room.queue;

  assert.equal(room.game.players.length, 0);
  assert.equal(room.summary().canJoin, true);

  const carol = session('player-carol', 'Carol');
  await room.join(carol, { id: 'player-carol', name: 'Carol' });
  assert.equal(room.game.players.length, 1);
});

test('public worker lists five xo table summaries', async () => {
  const seen = [];
  const env = {
    XO_ROOMS: {
      idFromName: (code) => code,
      get: (id) => ({
        fetch: async (request) => {
          seen.push({ id, url: request.url, internal: request.headers.get('x-internal-room') });
          return new Response(JSON.stringify({ code: id, players: 0, maxPlayers: 2, phase: 'waiting', canJoin: true, gameOver: false }), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
  const response = await worker.fetch(new Request('https://game.test/api/xo/rooms?pid=player-1'), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.rooms.map((room) => room.code), ['XO01', 'XO02', 'XO03', 'XO04', 'XO05']);
  assert.equal(seen.length, 5);
  assert.ok(seen.every((request) => request.internal === '1'));
});

test('unknown xo table codes are rejected', async () => {
  const response = await worker.fetch(new Request('https://game.test/api/xo/room/XO99', { headers: { Upgrade: 'websocket' } }), {});
  assert.equal(response.status, 404);
});

test('the xo app shell is served from the assets binding', async () => {
  const env = {
    ASSETS: {
      fetch: async (request) => new Response(`ASSET:${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/html' } }),
    },
  };
  for (const path of ['/xo', '/xo/']) {
    const response = await worker.fetch(new Request(`https://game.test${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ASSET:/xo/index.html');
  }
});

test('a socket that never joined cannot restart a finished XO match', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  const intruder = session('player-intruder', 'Intruder');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });
  room.game.gameOver = true;
  room.game.winner = 'player-alice';

  await room.restart(intruder);

  assert.equal(last(intruder).type, 'error');
  assert.equal(room.game.gameOver, true);
});

test('makeMove rejects malformed cell values instead of coercing them', () => {
  const game = addPlayer(addPlayer(initialGame(), { id: 'a' }), { id: 'b' });
  for (const cell of [null, undefined, false, true, '', '  ', '0', [], {}]) {
    const result = makeMove(game, 'a', cell);
    assert.equal(result.ok, false, `cell ${JSON.stringify(cell)} must be rejected`);
    assert.match(result.error, /Ô không hợp lệ/);
  }
  for (const cell of [-1, 9, 3.5, NaN]) {
    assert.equal(makeMove(game, 'a', cell).ok, false, `cell ${cell} must be rejected`);
  }
  assert.equal(makeMove(game, 'a', 0).ok, true);
});

test('a malformed xo cell from a client is rejected and keeps the board', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });

  await room.move(alice, { cell: null });

  assert.equal(last(alice).type, 'error');
  assert.match(last(alice).message, /Ô không hợp lệ/);
  assert.ok(room.game.board.every((cell) => cell === null));
  assert.equal(room.game.turn, 0);
});

test('an invalid xo move during offline takeover does not advance the turn', async () => {
  const room = await xoRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });
  assert.equal(room.game.turn, 0);
  room.game.players[0].connected = false; // alice owns turn 0 but is gone

  await room.move(bob, { cell: 9 }); // out of range

  assert.equal(room.game.turn, 0); // takeover is rolled back
  assert.equal(last(bob).type, 'error');
  assert.match(last(bob).message, /Ô không hợp lệ/);
});

test('a hydrated xo game marks seats offline so newcomers can reclaim them', async () => {
  const room = await xoRoom({
    players: [
      { id: 'player-alice', name: 'Alice', connected: true },
      { id: 'player-bob', name: 'Bob', connected: true },
    ],
    board: ['X', '', '', '', '', '', '', '', ''],
    turn: 1, gameOver: false, draw: false, winner: null, lastMove: null,
  });
  assert.ok(room.game.players.every((player) => player.connected === false));
  assert.equal(room.summary().canJoin, true);

  const carol = session('player-carol', 'Carol');
  room.sockets.set(carol.socket, carol);
  await room.join(carol, { id: 'player-carol', name: 'Carol' });
  assert.equal(room.game.players.length, 2);
  assert.ok(room.game.players.some((player) => player.id === 'player-carol'));
  assert.equal(last(carol).type, 'state');
});
