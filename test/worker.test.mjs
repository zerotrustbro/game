import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Room } from '../worker/index.js';

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

test('started room summaries reject newcomers while allowing existing players to reconnect', async () => {
  const room = await createRoom({}, {
    phase: 'game',
    hostId: 'host-player',
    players: [{ id: 'host-player', name: 'Host', avatar: 1, connected: false }],
    game: null,
    roomCode: 'BAN01',
    roundId: 'ROUND1',
  });
  const summaryResponse = await room.fetch(new Request('https://room/summary?code=BAN01', { headers: { 'x-internal-room': '1' } }));
  assert.equal(summaryResponse.status, 200);
  assert.deepEqual(await summaryResponse.json(), {
    code: 'BAN01', players: 1, maxPlayers: 4, phase: 'game', canJoin: false,
  });
  const existingSummary = await room.fetch(new Request('https://room/summary?code=BAN01&pid=host-player', { headers: { 'x-internal-room': '1' } }));
  assert.equal((await existingSummary.json()).canJoin, true);

  const newcomer = session('new-player');
  room.sockets.set(newcomer.socket, newcomer);
  await room.join(newcomer, { id: 'new-player', name: 'New', avatar: 1 });
  assert.equal(room.room.players.length, 1);
  assert.match(newcomer.socket.messages.at(-1).message, /đã bắt đầu/);
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
    roundId: null,
    settlement: { status: 'complete', penalty: 10, changes: [] },
  });

  assert.equal(room.room.players.length, 2);
  assert.ok(room.room.players.every((player) => !('accountId' in player) && !('coins' in player) && !('username' in player)));
  assert.equal(room.room.players[0].name, 'Host');
  assert.equal(room.getPersisted().players[0].name, 'Host');
  assert.equal(room.room.hostId, legacyId);
});
