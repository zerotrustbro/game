import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Room } from '../worker/index.js';
import { dealGame } from '../tienlen/public/engine.js';

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

function session(id = crypto.randomUUID()) {
  return { socket: createSocket(), playerId: null, id };
}

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

  const response = await worker.fetch(new Request('https://game.test/api/rooms?pid=player-1'), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.rooms.map((room) => room.code), ['BAN01', 'BAN02', 'BAN03', 'BAN04', 'BAN05']);
  assert.equal(seen.length, 5);
  assert.ok(seen.every((request) => request.internal === '1'));
});

test('hydrated ghost game rooms reopen as joinable lobbies', async () => {
  const room = await createRoom({}, {
    phase: 'game',
    hostId: 'host-player',
    players: [
      { id: 'host-player', name: 'Host', avatar: 1, connected: true },
      { id: 'guest-player', name: 'Guest', avatar: 2, connected: true },
    ],
    game: { players: [{ id: 'host-player', hand: [] }, { id: 'guest-player', hand: ['3s'] }], turnIndex: 0, currentPlay: null, passCount: 0, mustStart: true, gameOver: false, winner: null },
    roomCode: 'BAN01',
  });
  // After a DO eviction/restart no WebSocket survives: seats become ghosts,
  // a mid-game table is reopened as a lobby, and the host role stays with
  // the surviving host seat until a live player joins.
  assert.equal(room.room.phase, 'lobby');
  assert.equal(room.room.game, null);
  assert.equal(room.room.hostId, 'host-player');
  assert.ok(room.room.players.every((player) => player.connected === false));
  const summaryResponse = await room.fetch(new Request('https://room/summary?code=BAN01', { headers: { 'x-internal-room': '1' } }));
  assert.equal(summaryResponse.status, 200);
  assert.deepEqual(await summaryResponse.json(), {
    code: 'BAN01', players: 2, maxPlayers: 4, phase: 'lobby', canJoin: true,
  });

  const newcomer = session('new-player');
  room.sockets.set(newcomer.socket, newcomer);
  await room.join(newcomer, { id: 'new-player', name: 'New', avatar: 1 });
  assert.equal(room.room.players.length, 3);
  assert.ok(room.room.players.some((player) => player.id === 'new-player'));
  // the offline host seat yields the host role to the first live joiner
  assert.equal(room.room.hostId, 'new-player');
});

test('a live game room rejects newcomers while existing players reconnect', async () => {
  const room = await createRoom();
  const host = session('host-player');
  const guest = session('guest-player');
  room.sockets.set(host.socket, host);
  room.sockets.set(guest.socket, guest);
  await room.join(host, { id: 'host-player', name: 'Host', avatar: 1 });
  await room.join(guest, { id: 'guest-player', name: 'Guest', avatar: 1 });
  await room.start(host);
  assert.equal(room.room.phase, 'game');

  const newcomer = session('new-player');
  room.sockets.set(newcomer.socket, newcomer);
  await room.join(newcomer, { id: 'new-player', name: 'New', avatar: 1 });
  assert.equal(room.room.players.length, 2);
  assert.match(newcomer.socket.messages.at(-1).message, /đã bắt đầu/);
  assert.equal(newcomer.socket.messages.at(-1).fatal, true);

  const summary = await room.fetch(new Request('https://room/summary?code=BAN01&pid=new-player', { headers: { 'x-internal-room': '1' } }));
  assert.equal((await summary.json()).canJoin, false);
  const existingSummary = await room.fetch(new Request('https://room/summary?code=BAN01&pid=host-player', { headers: { 'x-internal-room': '1' } }));
  assert.equal((await existingSummary.json()).canJoin, true);
});

test('a full lobby of ghost seats is reclaimable by a newcomer', async () => {
  const room = await createRoom({}, {
    phase: 'lobby',
    hostId: 'player-1',
    players: [
      { id: 'player-1', name: 'P1', avatar: 1, connected: true },
      { id: 'player-2', name: 'P2', avatar: 2, connected: true },
      { id: 'player-3', name: 'P3', avatar: 3, connected: true },
      { id: 'player-4', name: 'P4', avatar: 4, connected: true },
    ],
    game: null,
    roomCode: 'BAN01',
  });
  assert.equal(room.summary('stranger').canJoin, true);

  const newcomer = session('new-player');
  room.sockets.set(newcomer.socket, newcomer);
  await room.join(newcomer, { id: 'new-player', name: 'New', avatar: 1 });
  assert.equal(room.room.players.length, 4);
  assert.ok(room.room.players.some((player) => player.id === 'new-player'));
  assert.equal(room.room.hostId, 'new-player');
  assert.equal(newcomer.socket.messages.at(-1).type, 'state');
});

test('players join a lobby table by nickname and avatar', async () => {
  const room = await createRoom();
  const host = session('host-player');
  const guest = session('guest-player');
  room.sockets.set(host.socket, host);
  room.sockets.set(guest.socket, guest);

  await room.join(host, { id: 'host-player', name: 'Host', avatar: 2 });
  await room.join(guest, { id: 'guest-player', name: 'Guest', avatar: 3 });

  assert.equal(room.room.players.length, 2);
  assert.deepEqual(room.room.players.map((player) => ({ name: player.name, avatar: player.avatar })), [{ name: 'Host', avatar: 2 }, { name: 'Guest', avatar: 3 }]);
  assert.equal(room.room.hostId, 'host-player');
  assert.equal(room.room.phase, 'lobby');
});

test('reconnecting with the same id reclaims the seat without duplicating', async () => {
  const room = await createRoom();
  const host = session('host-player');
  room.sockets.set(host.socket, host);
  await room.join(host, { id: 'host-player', name: 'Host', avatar: 1 });

  const second = session('host-player');
  room.sockets.set(second.socket, second);
  await room.join(second, { id: 'host-player', name: 'Host', avatar: 1 });

  assert.equal(room.room.players.length, 1);
  assert.equal(second.playerId, 'host-player');
});

test('a full lobby rejects a fourth player', async () => {
  const room = await createRoom();
  for (let i = 1; i <= 4; i++) {
    const s = session(`player-${i}`);
    room.sockets.set(s.socket, s);
    await room.join(s, { id: `player-${i}`, name: `P${i}`, avatar: 1 });
  }
  const fifth = session('player-5');
  room.sockets.set(fifth.socket, fifth);
  await room.join(fifth, { id: 'player-5', name: 'P5', avatar: 1 });
  assert.equal(room.room.players.length, 4);
  assert.match(fifth.socket.messages.at(-1).message, /đủ 4 người/);
});

test('a nickname is sanitized and truncated to 18 characters', async () => {
  const room = await createRoom();
  const s = session('player-a');
  room.sockets.set(s.socket, s);
  await room.join(s, { id: 'player-a', name: '<script>hacker-name-very-long-extra', avatar: 9 });
  const name = room.room.players[0].name;
  assert.ok(name.length <= 18);
  assert.ok(!name.includes('<') && !name.includes('>'));
  assert.equal(name, 'scripthacker-name-');
  assert.equal(room.room.players[0].avatar, 1);
});

test('two sockets with the same id share one seat (reconnect semantics)', async () => {
  const room = await createRoom();
  const host = session('same-id-1234');
  const second = session('same-id-1234');
  room.sockets.set(host.socket, host);
  room.sockets.set(second.socket, second);

  await room.join(host, { id: 'same-id-1234', name: 'Host', avatar: 1 });
  assert.equal(host.playerId, 'same-id-1234');
  await room.join(second, { id: 'same-id-1234', name: 'Host', avatar: 1 });

  assert.equal(room.room.players.length, 1);
  assert.equal(second.playerId, 'same-id-1234');
  // the earlier socket loses the seat to the newest connection
  assert.equal([...room.sockets.values()].find((s) => s === host).playerId, null);
});

test('legacy saved rooms drop account fields during normalization', async () => {
  const legacyId = '00000000-0000-4000-8000-000000000001';
  const room = await createRoom({}, {
    phase: 'lobby',
    hostId: legacyId,
    players: [
      { id: legacyId, accountId: 'account-host', username: 'host', name: 'Host', coins: 100, avatar: 1, connected: false },
      { id: 'another-player', accountId: 'account-guest', username: 'guest', name: 'Guest', coins: 90, avatar: 2, connected: false },
    ],
    game: null,
    roomCode: 'BAN01',
    settlement: { status: 'complete', penalty: 10, changes: [] },
  });

  assert.equal(room.room.players.length, 2);
  assert.ok(room.room.players.every((player) => !('accountId' in player) && !('coins' in player) && !('username' in player)));
  assert.equal(room.room.players[0].name, 'Host');
  assert.equal(room.getPersisted().players[0].name, 'Host');
  assert.ok(!('settlement' in room.getPersisted()));
  // rehydration keeps the host role on the surviving host seat
  assert.equal(room.room.hostId, legacyId);
});

test('legacy game rooms drop account fields and stale matches during rehydration', async () => {
  const room = await createRoom({}, {
    phase: 'game',
    hostId: 'host-player',
    players: [
      { id: 'host-player', name: 'Host', avatar: 1, connected: true },
      { id: 'guest-player', name: 'Guest', avatar: 2, connected: true },
    ],
    game: {
      accountId: 'account-game', coins: 50, settlement: { status: 'done' },
      players: [
        { id: 'host-player', name: 'Host', avatar: 1, hand: ['3s'], accountId: 'account-host', xu: 20 },
        { id: 'guest-player', name: 'Guest', avatar: 2, hand: ['4s'], coins: 10 },
      ],
      turnIndex: 0, currentPlay: null, passCount: 0, mustStart: true, gameOver: false, winner: null,
    },
    roomCode: 'BAN01',
  });
  // the stale match cannot resume without its players, so it is discarded
  assert.equal(room.room.phase, 'lobby');
  assert.equal(room.room.game, null);
  assert.ok(room.room.players.every((player) => player.connected === false));
  const persisted = room.getPersisted();
  assert.ok(persisted.players.every((player) => !('accountId' in player) && !('xu' in player) && !('coins' in player)));
  assert.ok(!('settlement' in persisted) && !('accountId' in persisted) && !('coins' in persisted));
});

test('disconnecting from the lobby frees the seat and reassigns the host', async () => {
  const room = await createRoom();
  const host = session('host-player');
  const guest = session('guest-player');
  room.sockets.set(host.socket, host);
  room.sockets.set(guest.socket, guest);
  await room.join(host, { id: 'host-player', name: 'Host', avatar: 1 });
  await room.join(guest, { id: 'guest-player', name: 'Guest', avatar: 1 });

  room.onClose(host);
  await room.queue;

  assert.deepEqual(room.room.players.map((player) => player.id), ['guest-player']);
  assert.equal(room.room.hostId, 'guest-player');
  assert.equal(room.room.phase, 'lobby');
  assert.equal(room.summary('new-player').canJoin, true);
});

test('leaving a finished match returns the remaining player to a joinable lobby', async () => {
  const room = await createRoom();
  const host = session('host-player');
  const guest = session('guest-player');
  room.sockets.set(host.socket, host);
  room.sockets.set(guest.socket, guest);
  await room.join(host, { id: 'host-player', name: 'Host', avatar: 1 });
  await room.join(guest, { id: 'guest-player', name: 'Guest', avatar: 1 });
  room.room.phase = 'game';
  room.room.game = { players: [{ id: 'host-player', hand: [] }, { id: 'guest-player', hand: ['3s'] }], gameOver: true, winner: 'host-player' };

  room.onClose(guest);
  await room.queue;

  assert.equal(room.room.phase, 'lobby');
  assert.deepEqual(room.room.players.map((player) => player.id), ['host-player']);
  assert.equal(room.summary('new-player').canJoin, true);
});

test('an explicit leave removes a player and closes only that socket', async () => {
  const room = await createRoom();
  const host = session('host-player');
  const guest = session('guest-player');
  room.sockets.set(host.socket, host);
  room.sockets.set(guest.socket, guest);
  await room.join(host, { id: 'host-player', name: 'Host', avatar: 1 });
  await room.join(guest, { id: 'guest-player', name: 'Guest', avatar: 1 });

  await room.leave(host);

  assert.deepEqual(room.room.players.map((player) => player.id), ['guest-player']);
  assert.equal(room.sockets.has(host.socket), false);
  assert.equal(room.sockets.has(guest.socket), true);
});

test('api endpoints reject non-GET methods and unknown api paths return json 404', async () => {
  const env = {
    ROOMS: { idFromName: () => ({ get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }) }) },
    POKI_ROOMS: { idFromName: () => ({ get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }) }) },
    XO_ROOMS: { idFromName: () => ({ get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }) }) },
  };
  for (const path of ['/api/rooms', '/api/poki/rooms', '/api/xo/rooms', '/api/health']) {
    const response = await worker.fetch(new Request(`https://game.test${path}`, { method: 'POST' }), env);
    assert.equal(response.status, 405);
    assert.match(response.headers.get('content-type'), /json/);
    assert.equal((await response.json()).error, 'Method not allowed');
  }
  const unknown = await worker.fetch(new Request('https://game.test/api/rooms/BAN99/secret'), env);
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type'), /json/);
  assert.equal((await unknown.json()).error, 'Không tìm thấy API này.');
});

test('invalid plays never move or persist the turn', async () => {
  const room = await createRoom();
  const host = session('host-player');
  const guest = session('guest-player');
  room.sockets.set(host.socket, host);
  room.sockets.set(guest.socket, guest);
  await room.join(host, { id: 'host-player', name: 'Host', avatar: 1 });
  await room.join(guest, { id: 'guest-player', name: 'Guest', avatar: 1 });
  await room.start(host);
  room.room.game.mustStart = false;
  const persistedTurn = room.getPersisted().game.turnIndex;

  // invalid action while everyone is connected
  await room.play(host, ['not-a-card']);
  assert.equal(host.socket.messages.at(-1).type, 'error');
  assert.equal(room.room.game.turnIndex, persistedTurn);
  assert.equal(room.getPersisted().game.turnIndex, persistedTurn);

  // invalid action while the turn holder is offline: the ghost is skipped
  // (legitimate progress), but the rejection is never persisted
  room.room.game.turnIndex = 1;
  room.room.players.find((player) => player.id === 'guest-player').connected = false;
  await room.play(host, ['not-a-card']);
  assert.equal(host.socket.messages.at(-1).type, 'error');
  assert.equal(room.room.game.turnIndex, 0); // auto-skip reached the requester
  assert.equal(room.getPersisted().game.turnIndex, persistedTurn);

  // the same holds for an invalid pass
  room.room.game.turnIndex = 1;
  await room.pass(host);
  assert.equal(host.socket.messages.at(-1).type, 'error');
  assert.equal(room.getPersisted().game.turnIndex, persistedTurn);
});

test('a rematch never includes seats whose owners disconnected mid-match', async () => {
  const room = await createRoom();
  const host = session('host-player');
  const guest = session('guest-player');
  room.sockets.set(host.socket, host);
  room.sockets.set(guest.socket, guest);
  await room.join(host, { id: 'host-player', name: 'Host', avatar: 1 });
  await room.join(guest, { id: 'guest-player', name: 'Guest', avatar: 1 });
  await room.start(host);
  room.room.game.gameOver = true;
  room.room.game.winner = 'host-player';
  room.room.players.find((player) => player.id === 'guest-player').connected = false;

  await room.restart(host);

  assert.equal(host.socket.messages.at(-1).type, 'error');
  assert.match(host.socket.messages.at(-1).message, /2 người/);
  assert.deepEqual(room.room.players.map((player) => player.id), ['host-player']);
});
