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

async function createRoom(env = {}) {
  const room = new Room({
    storage: {
      async get() {
        return undefined;
      },
      async put() {},
    },
  }, env);
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
