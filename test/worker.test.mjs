import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { AccountStore, Room } from '../worker/index.js';

function createStore() {
  const values = new Map();
  return new AccountStore({
    storage: {
      async get(key) {
        return values.get(key);
      },
      async put(key, value) {
        values.set(key, structuredClone(value));
      },
    },
  });
}

function createSocket() {
  return {
    messages: [],
    send(message) {
      this.messages.push(JSON.parse(message));
    },
  };
}

async function createRoom(env = {}, saved = undefined) {
  let persisted = saved;
  const room = new Room({
    storage: {
      async get() {
        return persisted;
      },
      async put(key, value) {
        persisted = structuredClone(value);
      },
    },
  }, env);
  room.getPersisted = () => persisted;
  await room.ready;
  return room;
}

async function register(store, username, protocol = 'http:') {
  const response = await store.fetch(new Request(`https://accounts/register?client_proto=${encodeURIComponent(protocol)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, displayName: username, password: 'secret-123' }),
  }));
  assert.equal(response.status, 201);
  return { user: (await response.json()).user, cookie: response.headers.get('set-cookie') };
}

test('account sessions honor the original protocol and settlement is idempotent', async () => {
  const store = createStore();
  const winner = await register(store, 'winner', 'https:');
  const loserA = await register(store, 'losera');
  const loserB = await register(store, 'loserb');

  assert.match(winner.cookie, /; Secure;/);
  assert.doesNotMatch(loserA.cookie, /; Secure;/);

  const body = JSON.stringify({
    reference: 'ROOM1:ROUND1',
    winnerId: winner.user.id,
    loserIds: [loserA.user.id, loserB.user.id],
  });
  const request = () => store.fetch(new Request('https://accounts/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-account': '1' },
    body,
  }));

  const first = await (await request()).json();
  const replay = await (await request()).json();
  assert.deepEqual(first, replay);
  assert.deepEqual(first.balances, {
    [winner.user.id]: 120,
    [loserA.user.id]: 90,
    [loserB.user.id]: 90,
  });
  assert.deepEqual(first.changes, [
    { userId: loserA.user.id, amount: -10 },
    { userId: loserB.user.id, amount: -10 },
    { userId: winner.user.id, amount: 20 },
  ]);
});

test('room websocket is rejected without an account session', async () => {
  const env = {
    ACCOUNTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ user: null }), { status: 401 }),
      }),
    },
  };
  const response = await worker.fetch(new Request('https://game.test/api/room/BAN01', { headers: { Upgrade: 'websocket' } }), env);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /đăng nhập/);
});

test('public worker lists five room summaries', async () => {
  const seen = [];
  const env = {
    ROOMS: {
      idFromName: (code) => code,
      get: (id) => ({
        fetch: async (request) => {
          seen.push({ id, url: request.url, internal: request.headers.get('x-internal-room') });
          return new Response(JSON.stringify({ code: id, players: 0, maxPlayers: 4, phase: 'lobby', canJoin: true }), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };

  const response = await worker.fetch(new Request('https://game.test/api/rooms'), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.rooms.map((room) => room.code), ['BAN01', 'BAN02', 'BAN03', 'BAN04', 'BAN05']);
  assert.equal(seen.length, 5);
  assert.ok(seen.every((request) => request.internal === '1'));
});

test('started room summaries reject newcomers while allowing existing players to reconnect', async () => {
  const room = await createRoom({}, {
    phase: 'game',
    hostId: 'host-player',
    players: [{ id: 'host-player', accountId: 'account-host', name: 'Host', coins: 100, connected: false }],
    game: null,
    roomCode: 'BAN01',
    roundId: 'ROUND1',
    settlement: null,
  });
  const summaryResponse = await room.fetch(new Request('https://room/summary?code=BAN01', { headers: { 'x-internal-room': '1' } }));
  assert.equal(summaryResponse.status, 200);
  assert.deepEqual(await summaryResponse.json(), {
    code: 'BAN01', players: 1, maxPlayers: 4, phase: 'game', canJoin: false,
  });
  const existingSummary = await room.fetch(new Request('https://room/summary?code=BAN01', { headers: { 'x-internal-room': '1', 'x-account-id': 'account-host' } }));
  assert.equal((await existingSummary.json()).canJoin, true);

  const newcomer = { socket: createSocket(), playerId: null, account: { id: 'account-new', username: 'new', displayName: 'New', coins: 100 } };
  room.sockets.set(newcomer.socket, newcomer);
  await room.join(newcomer, { name: 'New', avatar: 1 });
  assert.equal(room.room.players.length, 1);
  assert.match(newcomer.socket.messages.at(-1).message, /đã bắt đầu/);
});

test('migrates legacy duplicate player ids before authorization checks', async () => {
  const legacyId = '00000000-0000-4000-8000-000000000001';
  const room = await createRoom({}, {
    phase: 'lobby',
    hostId: legacyId,
    players: [
      { id: legacyId, accountId: 'account-host', name: 'Host', coins: 100, connected: false },
      { id: legacyId, accountId: 'account-attacker', name: 'Attacker', coins: 100, connected: false },
    ],
    game: null,
    roomCode: 'BAN01',
    roundId: null,
    settlement: null,
  });

  assert.notEqual(room.room.players[0].id, room.room.players[1].id);
  assert.equal(room.room.hostId, room.room.players[0].id);
  assert.equal(room.getPersisted().players[0].id, room.room.players[0].id);
  assert.equal(room.getPersisted().players[1].id, room.room.players[1].id);

  const attacker = { socket: createSocket(), playerId: null, account: { id: 'account-attacker', username: 'attacker', displayName: 'Attacker', coins: 100 } };
  room.sockets.set(attacker.socket, attacker);
  await room.join(attacker, { name: 'Attacker', avatar: 2 });
  await room.start(attacker);
  assert.equal(attacker.playerId, room.room.players[1].id);
  assert.notEqual(attacker.playerId, room.room.hostId);
  assert.equal(attacker.socket.messages.at(-1).type, 'error');
});

test('persists completed settlement before rematch affordability can fail', async () => {
  const room = await createRoom({
    ACCOUNTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async () => new Response(JSON.stringify({
          penalty: 10,
          changes: [{ userId: 'account-loser', amount: -10 }, { userId: 'account-host', amount: 10 }],
          balances: { 'account-host': 20, 'account-loser': 0 },
        })),
      }),
    },
  });
  room.room.roomCode = 'BAN01';
  room.room.roundId = 'ROUND1';
  room.room.phase = 'game';
  room.room.hostId = 'host-player';
  room.room.players = [
    { id: 'host-player', accountId: 'account-host', coins: 10, connected: true },
    { id: 'loser-player', accountId: 'account-loser', coins: 10, connected: true },
  ];
  room.room.game = {
    gameOver: true,
    winner: 'host-player',
    players: [{ id: 'host-player', accountId: 'account-host' }, { id: 'loser-player', accountId: 'account-loser' }],
  };
  const host = { socket: createSocket(), playerId: 'host-player', account: { id: 'account-host', coins: 10 } };
  room.sockets.set(host.socket, host);

  await room.restart(host);
  assert.equal(room.room.phase, 'game');
  assert.equal(room.room.settlement.status, 'complete');
  assert.equal(room.getPersisted().settlement.status, 'complete');
  assert.equal(room.getPersisted().players.find((player) => player.accountId === 'account-loser').coins, 0);
  assert.equal(host.socket.messages.at(-1).type, 'error');
});

test('room assigns canonical player ids instead of trusting client collisions', async () => {
  const room = await createRoom();
  const host = { socket: createSocket(), playerId: null, account: { id: 'account-host', username: 'host', displayName: 'Host', coins: 100 } };
  const attacker = { socket: createSocket(), playerId: null, account: { id: 'account-attacker', username: 'attacker', displayName: 'Attacker', coins: 100 } };
  room.sockets.set(host.socket, host);
  room.sockets.set(attacker.socket, attacker);

  await room.join(host, { playerId: 'shared-client-id', name: 'Host', avatar: 1 });
  await room.join(attacker, { playerId: 'shared-client-id', name: 'Attacker', avatar: 2 });

  assert.notEqual(host.playerId, attacker.playerId);
  assert.equal(room.room.hostId, host.playerId);
  await room.start(attacker);
  assert.equal(room.room.phase, 'lobby');
  assert.equal(attacker.socket.messages.at(-1).type, 'error');

  await room.start(host);
  const roundId = room.room.roundId;
  await room.start(host);
  assert.equal(room.room.phase, 'game');
  assert.equal(room.room.roundId, roundId);
  assert.equal(host.socket.messages.at(-1).type, 'error');
});

test('public auth proxy cannot expose internal account routes or headers', async () => {
  let forwarded;
  const env = {
    ACCOUNTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async (request) => {
          forwarded = request;
          return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
  const internalPath = await worker.fetch(new Request('https://game.test/api/auth/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-account': '1' },
  }), env);
  assert.equal(internalPath.status, 404);
  assert.equal(forwarded, undefined);

  await worker.fetch(new Request('https://game.test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-account': '1' },
  }), env);
  assert.equal(forwarded.headers.get('x-internal-account'), null);
});

test('failed settlement stays retryable and blocks rematch', async () => {
  let attempts = 0;
  const room = await createRoom({
    ACCOUNTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async () => {
          attempts += 1;
          return new Response(JSON.stringify({ error: 'temporary failure' }), { status: 503 });
        },
      }),
    },
  });
  room.room.roomCode = 'ROOM1';
  room.room.roundId = 'ROUND1';
  room.room.phase = 'game';
  room.room.hostId = 'host-player';
  room.room.players = [
    { id: 'host-player', accountId: 'account-host', coins: 100, connected: true },
    { id: 'loser-player', accountId: 'account-loser', coins: 100, connected: true },
  ];
  room.room.game = {
    gameOver: true,
    winner: 'host-player',
    players: [
      { id: 'host-player', accountId: 'account-host' },
      { id: 'loser-player', accountId: 'account-loser' },
    ],
  };
  const host = { socket: createSocket(), playerId: 'host-player', account: { id: 'account-host', coins: 100 } };
  room.sockets.set(host.socket, host);

  const originalError = console.error;
  console.error = () => {};
  try {
    const firstAttempt = await room.settleGame(room.room.game);
    assert.equal(firstAttempt, false);
    assert.equal(room.room.settlement.status, 'failed');

    await room.restart(host);
    assert.equal(room.room.phase, 'game');
    assert.equal(room.room.settlement.status, 'failed');
    assert.equal(attempts, 2);
    assert.equal(host.socket.messages.at(-1).type, 'error');
  } finally {
    console.error = originalError;
  }
});
