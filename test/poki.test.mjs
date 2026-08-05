import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { PokiRoom } from '../worker/index.js';
import { validMoves } from '../poki/public/game.js';

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

function session(accountId, displayName = accountId) {
  return { socket: createSocket(), account: { id: accountId, username: accountId, displayName } };
}

const last = (item) => item.socket.messages.at(-1);

test('poki room summary starts empty, joinable, and without a finished match', async () => {
  const room = await pokiRoom();
  assert.deepEqual(room.summary(), {
    code: 'POKI??', players: 0, maxPlayers: 2, phase: 'waiting', canJoin: true, gameOver: false,
  });
});

test('poki room accepts exactly two accounts and rejects a third', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  const bob = session('account-bob', 'Bob');
  const carol = session('account-carol', 'Carol');
  await room.join(alice, { monster: 'emberfox' });
  await room.join(bob, { monster: 'stonehorn' });
  await room.join(carol, { monster: 'miubeo' });

  assert.equal(room.battle.players.length, 2);
  assert.deepEqual(room.battle.players.map((player) => player.id).sort(), ['account-alice', 'account-bob']);
  assert.equal(last(carol).type, 'error');
  assert.equal(last(carol).fatal, true);
  assert.match(last(carol).message, /đủ 2 người/);
});

test('a reconnecting player keeps their seat and the battle in progress', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  const bob = session('account-bob', 'Bob');
  await room.join(alice, { monster: 'emberfox' });
  await room.join(bob, { monster: 'stonehorn' });
  const firstBoard = room.battle.board;
  room.battle.turn = 3;

  await room.join(alice, { monster: 'voltwing' });

  assert.equal(room.battle.players.length, 2);
  assert.equal(room.battle.turn, 3);
  assert.equal(room.battle.board, firstBoard);
  assert.equal(room.battle.players.find((player) => player.id === 'account-alice').monster, 'voltwing');
  assert.equal(room.battle.players.find((player) => player.id === 'account-alice').connected, true);
});

test('an offline player can be replaced so a 1v1 table never gets stuck', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  const bob = session('account-bob', 'Bob');
  await room.join(alice, { monster: 'emberfox' });
  await room.join(bob, { monster: 'stonehorn' });
  room.battle.players.find((player) => player.id === 'account-bob').connected = false;

  const carol = session('account-carol', 'Carol');
  await room.join(carol, { monster: 'miubeo' });

  assert.equal(room.battle.players.length, 2);
  assert.ok(room.battle.players.every((player) => player.id !== 'account-bob'));
  assert.ok(room.battle.players.some((player) => player.id === 'account-carol'));
  assert.ok(!room.battle.gameOver);
  assert.equal(room.battle.turn, 0);
});

test('moves require the active player and advance the turn on a valid swap', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  const bob = session('account-bob', 'Bob');
  await room.join(alice, { monster: 'emberfox' });
  await room.join(bob, { monster: 'stonehorn' });

  await room.move(bob, { from: { x: 0, y: 0 }, to: { x: 1, y: 0 } });
  assert.equal(last(bob).type, 'error');
  assert.match(last(bob).message, /Chưa đến lượt/);

  const first = validMoves(room.battle.board)[0];
  assert.ok(first);
  await room.move(alice, { from: first.from, to: first.to });
  assert.equal(room.battle.turn, 1);
  assert.equal(room.getPersisted().turn, 1);
});

test('moves are rejected before two players join', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  await room.join(alice, { monster: 'emberfox' });
  await room.move(alice, { from: { x: 0, y: 0 }, to: { x: 1, y: 0 } });
  assert.equal(last(alice).type, 'error');
  assert.match(last(alice).message, /chưa đủ hai người/);
});

test('special requires 100 mana and spends it on cast', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  const bob = session('account-bob', 'Bob');
  await room.join(alice, { monster: 'emberfox' });
  await room.join(bob, { monster: 'stonehorn' });

  await room.special(alice);
  assert.equal(last(alice).type, 'error');
  assert.match(last(alice).message, /100 Mana/);

  room.battle.mana['account-alice'] = 100;
  await room.special(alice);
  assert.equal(room.battle.mana['account-alice'], 0);
  assert.equal(room.battle.turn, 1);
  assert.equal(room.battle.lastAction.special, true);
  assert.equal(room.battle.lastAction.skillName, 'Pháo Viêm Ngục');
});

test('restart is rejected mid-match and resets a finished battle', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  const bob = session('account-bob', 'Bob');
  await room.join(alice, { monster: 'emberfox' });
  await room.join(bob, { monster: 'stonehorn' });

  await room.restart(alice);
  assert.equal(last(alice).type, 'error');
  assert.match(last(alice).message, /chưa kết thúc/);

  room.battle.gameOver = true;
  room.battle.winner = 'account-alice';
  room.battle.loser = 'account-bob';
  await room.restart(alice);

  assert.ok(!room.battle.gameOver);
  assert.equal(room.battle.turn, 0);
  assert.equal(room.battle.players.length, 2);
  assert.ok(room.battle.players.every((player) => player.connected === true));
});

test('leave frees the seat and resets the battle for the remaining player', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  const bob = session('account-bob', 'Bob');
  await room.join(alice, { monster: 'emberfox' });
  await room.join(bob, { monster: 'stonehorn' });

  await room.leave(alice);

  assert.equal(room.battle.players.length, 1);
  assert.equal(room.battle.players[0].id, 'account-bob');
  assert.ok(!room.battle.gameOver);
  assert.equal(room.battle.turn, 0);

  const carol = session('account-carol', 'Carol');
  await room.join(carol, { monster: 'miubeo' });
  assert.equal(room.battle.players.length, 2);
});

test('summaries let existing players rejoin full tables but lock newcomers out', async () => {
  const room = await pokiRoom();
  const alice = session('account-alice', 'Alice');
  const bob = session('account-bob', 'Bob');
  await room.join(alice, { monster: 'emberfox' });
  await room.join(bob, { monster: 'stonehorn' });
  room.battle.gameOver = true;

  assert.deepEqual(room.summary('account-alice'), {
    code: 'POKI??', players: 2, maxPlayers: 2, phase: 'game', canJoin: true, gameOver: true,
  });
  assert.equal(room.summary('account-carol').canJoin, false);
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
  const response = await worker.fetch(new Request('https://game.test/api/poki/rooms'), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.rooms.map((room) => room.code), ['POKI01', 'POKI02', 'POKI03', 'POKI04', 'POKI05']);
  assert.equal(seen.length, 5);
  assert.ok(seen.every((request) => request.internal === '1'));
});

test('poki room websocket requires a logged-in account', async () => {
  const env = {
    ACCOUNTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ user: null }), { status: 401 }),
      }),
    },
  };
  const response = await worker.fetch(new Request('https://game.test/api/poki/room/POKI01', { headers: { Upgrade: 'websocket' } }), env);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /đăng nhập/);
});

test('poki room websocket forwards account identity to the durable object', async () => {
  let seen;
  const env = {
    ACCOUNTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ user: { id: 'acct-1', username: 'chung', displayName: 'Chung', coins: 100 } }), { headers: { 'content-type': 'application/json' } }),
      }),
    },
    POKI_ROOMS: {
      idFromName: (code) => code,
      get: (id) => ({
        fetch: async (request) => {
          seen = { id, account: request.headers.get('x-account-id'), display: request.headers.get('x-account-display-name'), upgrade: request.headers.get('Upgrade') };
          return new Response(null, { status: 200 });
        },
      }),
    },
  };
  const request = new Request('https://game.test/api/poki/room/POKI01', { headers: { Upgrade: 'websocket', Cookie: 'game_session=abc' } });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(seen, { id: 'POKI01', account: 'acct-1', display: 'Chung', upgrade: 'websocket' });
});

test('unknown poki table codes are rejected before account resolution', async () => {
  let accountCalls = 0;
  const env = {
    ACCOUNTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async () => { accountCalls += 1; return new Response(JSON.stringify({ user: null }), { status: 401 }); },
      }),
    },
  };
  const response = await worker.fetch(new Request('https://game.test/api/poki/room/POKI99', { headers: { Upgrade: 'websocket' } }), env);
  assert.equal(response.status, 404);
  assert.equal(accountCalls, 0);
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
