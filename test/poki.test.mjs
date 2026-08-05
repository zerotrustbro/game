import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { PokiRoom } from '../worker/index.js';
import { createBoard, validMoves } from '../poki/public/game.js';

function createSocket() {
  return {
    messages: [],
    send(message) {
      this.messages.push(JSON.parse(message));
    },
  };
}

function createPokiRoom(saved = undefined) {
  let persisted = saved;
  const room = new PokiRoom({
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

async function pokiRoom(saved) {
  const room = createPokiRoom(saved);
  await room.ready;
  return room;
}

function session(id, name = id) {
  return { socket: createSocket(), id, name };
}

const last = (item) => item.socket.messages.at(-1);

test('poki room summary starts empty, joinable, and without a finished match', async () => {
  const room = await pokiRoom();
  assert.deepEqual(room.summary(), {
    code: 'POKI??', players: 0, maxPlayers: 2, phase: 'waiting', canJoin: true, gameOver: false,
  });
});

test('poki room accepts exactly two players and rejects a third', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  const carol = session('player-carol', 'Carol');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  await room.join(carol, { id: 'player-carol', name: 'Carol', monster: 'miubeo' });

  assert.equal(room.battle.players.length, 2);
  assert.deepEqual(room.battle.players.map((player) => player.id).sort(), ['player-alice', 'player-bob']);
  assert.equal(last(carol).type, 'error');
  assert.equal(last(carol).fatal, true);
  assert.match(last(carol).message, /đủ 2 người/);
});

test('a reconnecting player keeps their seat and the battle in progress', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  const firstBoard = room.battle.board;
  room.battle.turn = 3;

  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'voltwing' });

  assert.equal(room.battle.players.length, 2);
  assert.equal(room.battle.turn, 3);
  assert.equal(room.battle.board, firstBoard);
  assert.equal(room.battle.players.find((player) => player.id === 'player-alice').monster, 'emberfox');
});

test('an offline player can be replaced so a 1v1 table never gets stuck', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  room.battle.players.find((player) => player.id === 'player-bob').connected = false;

  const carol = session('player-carol', 'Carol');
  await room.join(carol, { id: 'player-carol', name: 'Carol', monster: 'miubeo' });

  assert.equal(room.battle.players.length, 2);
  assert.ok(room.battle.players.every((player) => player.id !== 'player-bob'));
  assert.ok(room.battle.players.some((player) => player.id === 'player-carol'));
  assert.ok(!room.battle.gameOver);
  assert.equal(room.battle.turn, 0);
});

test('a stale offline waiting seat is replaced by the next player', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  room.battle.players[0].connected = false;
  assert.equal(room.summary().canJoin, true);
  const bob = session('player-bob', 'Bob');
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  assert.deepEqual(room.battle.players.map((player) => player.id), ['player-bob']);
});

test('a connected player can take over the turn of an offline opponent', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });

  // Bob's turn, but Bob is offline — Alice may act in his place.
  room.battle.turn = 1;
  room.battle.players.find((player) => player.id === 'player-bob').connected = false;
  const first = validMoves(room.battle.board)[0];
  assert.ok(first);
  await room.move(alice, { from: first.from, to: first.to });

  assert.ok(room.battle.lastAction, 'the takeover move was processed');
  assert.equal(room.battle.lastAction.player, 'player-alice');
});

test('an offline opponent does not block a special cast', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  room.battle.turn = 1;
  room.battle.players.find((player) => player.id === 'player-bob').connected = false;
  room.battle.mana['player-alice'] = 100;

  await room.special(alice);

  assert.ok(room.battle.lastAction?.special);
  assert.equal(room.battle.lastAction.player, 'player-alice');
  assert.equal(room.battle.mana['player-alice'], 0);
});

test('moves require the active player and advance the turn on a valid swap', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });

  await room.move(bob, { from: { x: 0, y: 0 }, to: { x: 1, y: 0 } });
  assert.equal(last(bob).type, 'error');
  assert.match(last(bob).message, /Chưa đến lượt/);

  const first = validMoves(room.battle.board)[0];
  assert.ok(first);
  await room.move(alice, { from: first.from, to: first.to });
  assert.equal(room.battle.turn, 1);
  assert.equal(room.getPersisted().turn, 1);
});

test('special requires 100 mana and spends it on cast', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });

  await room.special(alice);
  assert.equal(last(alice).type, 'error');
  assert.match(last(alice).message, /100 Mana/);

  room.battle.mana['player-alice'] = 100;
  await room.special(alice);
  assert.equal(room.battle.mana['player-alice'], 0);
  assert.equal(room.battle.turn, 1);
  assert.equal(room.battle.lastAction.special, true);
});

test('restart is rejected mid-match and resets a finished battle', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });

  await room.restart(alice);
  assert.equal(last(alice).type, 'error');
  assert.match(last(alice).message, /chưa kết thúc/);

  room.battle.gameOver = true;
  room.battle.winner = 'player-alice';
  room.battle.loser = 'player-bob';
  await room.restart(alice);

  assert.ok(!room.battle.gameOver);
  assert.equal(room.battle.turn, 0);
  assert.equal(room.battle.players.length, 2);
});

test('leave frees the seat and resets the battle for the remaining player', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });

  await room.leave(alice);

  assert.equal(room.battle.players.length, 1);
  assert.equal(room.battle.players[0].id, 'player-bob');
  assert.ok(!room.battle.gameOver);
  assert.equal(room.battle.turn, 0);

  const carol = session('player-carol', 'Carol');
  await room.join(carol, { id: 'player-carol', name: 'Carol', monster: 'miubeo' });
  assert.equal(room.battle.players.length, 2);
});

test('summaries let existing players rejoin full tables but lock newcomers out', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  room.battle.gameOver = true;

  assert.equal(room.summary('player-alice').canJoin, true);
  assert.equal(room.summary('player-carol').canJoin, false);
});

test('a table where everyone disconnected resets so newcomers can play', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  room.battle.players.forEach((player) => { player.connected = false; });

  room.onClose(alice);
  await room.queue;

  assert.equal(room.battle.players.length, 0);
  assert.equal(room.summary().canJoin, true);

  const carol = session('player-carol', 'Carol');
  await room.join(carol, { id: 'player-carol', name: 'Carol', monster: 'miubeo' });
  assert.equal(room.battle.players.length, 1);
});

test('public worker lists five poki table summaries', async () => {
  const seen = [];
  const env = {
    POKI_ROOMS: {
      idFromName: (code) => code,
      get: (id) => ({
        fetch: async (request) => {
          seen.push({ id, url: request.url, internal: request.headers.get('x-internal-room') });
          return new Response(JSON.stringify({ code: id, players: 0, maxPlayers: 2, phase: 'waiting', canJoin: true, gameOver: false }), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
  const response = await worker.fetch(new Request('https://game.test/api/poki/rooms?pid=player-1'), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.rooms.map((room) => room.code), ['POKI01', 'POKI02', 'POKI03', 'POKI04', 'POKI05']);
  assert.equal(seen.length, 5);
  assert.ok(seen.every((request) => request.internal === '1'));
});

test('unknown poki table codes are rejected', async () => {
  const response = await worker.fetch(new Request('https://game.test/api/poki/room/POKI99', { headers: { Upgrade: 'websocket' } }), {});
  assert.equal(response.status, 404);
});

test('the poki app shell is served from the assets binding', async () => {
  const env = {
    ASSETS: {
      fetch: async (request) => new Response(`ASSET:${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/html' } }),
    },
  };
  for (const path of ['/poki', '/poki/']) {
    const response = await worker.fetch(new Request(`https://game.test${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ASSET:/poki/index.html');
  }
});

test('a socket that never joined cannot restart a finished Poki match', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  const intruder = session('player-intruder', 'Intruder');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  room.battle.gameOver = true;
  room.battle.winner = 'player-alice';
  room.battle.loser = 'player-bob';

  await room.restart(intruder);

  assert.equal(last(intruder).type, 'error');
  assert.equal(room.battle.gameOver, true);
});

test('persisted battle resources survive an id repair during rehydration', async () => {
  const room = await pokiRoom({
    players: [{ id: 'short', name: 'Alice', monster: 'emberfox', connected: true }],
    board: createBoard(),
    hp: { short: 123 }, mana: { short: 99 }, shield: { short: 7 },
    turn: 0, gameOver: false,
  });
  const player = room.battle.players[0];
  // 'short' fails the ID pattern and is repaired to a canonical UUID
  assert.notEqual(player.id, 'short');
  assert.match(player.id, /^[0-9a-f-]{36}$/);
  // the values stored under the original key are preserved
  assert.equal(room.battle.hp[player.id], 123);
  assert.equal(room.battle.mana[player.id], 99);
  assert.equal(room.battle.shield[player.id], 7);
  // rehydration turns persisted seats into ghosts
  assert.equal(player.connected, false);
});

test('an invalid poki move during offline takeover does not advance the turn', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  assert.equal(room.battle.turn, 0);
  room.battle.players[0].connected = false; // alice owns turn 0 but is gone

  await room.move(bob, { from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }); // non-adjacent gems

  assert.equal(room.battle.turn, 0); // takeover is rolled back
  assert.equal(last(bob).type, 'error');
  assert.match(last(bob).message, /kề nhau/);
});

test('a hydrated battle marks seats offline so newcomers can reclaim them', async () => {
  const room = await pokiRoom({
    players: [
      { id: 'player-alice', name: 'Alice', monster: 'emberfox', connected: true },
      { id: 'player-bob', name: 'Bob', monster: 'stonehorn', connected: true },
    ],
    board: createBoard(),
    hp: { 'player-alice': 100, 'player-bob': 100 }, mana: {}, shield: {}, turn: 1, gameOver: false,
  });
  assert.ok(room.battle.players.every((player) => player.connected === false));
  assert.equal(room.summary().canJoin, true);

  const carol = session('player-carol', 'Carol');
  room.sockets.set(carol.socket, carol);
  await room.join(carol, { id: 'player-carol', name: 'Carol', monster: 'miubeo' });
  assert.equal(room.battle.players.length, 2);
  assert.ok(room.battle.players.some((player) => player.id === 'player-carol'));
  assert.equal(last(carol).type, 'state');
});

test('a poki rematch refuses to reuse a disconnected seat', async () => {
  const room = await pokiRoom();
  const alice = session('player-alice', 'Alice');
  const bob = session('player-bob', 'Bob');
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  room.battle.gameOver = true;
  room.battle.players.find((player) => player.id === 'player-bob').connected = false;

  await room.restart(alice);

  assert.equal(last(alice).type, 'error');
  assert.match(last(alice).message, /2 người/);
  assert.equal(room.battle.gameOver, true);
  // the ghost seat is kept so its owner can still reconnect
  assert.ok(room.battle.players.some((player) => player.id === 'player-bob'));
});
