// Probe suspected bugs before fixing them (run: node scripts/probe-bugs.mjs)
import { Room, PokiRoom, XoRoom } from '../worker/index.js';
import { dealGame } from '../tienlen/public/engine.js';
import { resolveSwap, SIZE } from '../poki/public/game.js';

function createSocket() {
  return { messages: [], send(message) { this.messages.push(JSON.parse(message)); } };
}
async function makeRoom(ctor) {
  const storage = { map: new Map(), async get(k) { return this.map.get(k); }, async put(k, v) { this.map.set(k, structuredClone(v)); } };
  const room = new ctor({ storage }, {});
  await room.ready;
  return room;
}
function attach(room, session) { room.sockets.set(session.socket, session); }
function findValidSwap(board) {
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const to = { x: x + dx, y: y + dy };
      if (to.x >= SIZE || to.y >= SIZE) continue;
      if (resolveSwap(board, { x, y }, to).valid) return [{ x, y }, to];
    }
  }
  return null;
}
const lastError = (sock) => [...sock.messages].reverse().find((m) => m.type === 'error');

// BUG A: poki — opponent offline mid-battle on their turn → table stuck forever
{
  const room = await makeRoom(PokiRoom);
  const alice = { socket: createSocket(), id: 'player-alice' };
  const bob = { socket: createSocket(), id: 'player-bob' };
  await room.join(alice, { id: 'player-alice', name: 'Alice', monster: 'emberfox' });
  await room.join(bob, { id: 'player-bob', name: 'Bob', monster: 'stonehorn' });
  attach(room, alice); attach(room, bob);
  room.battle.players.find((p) => p.id === 'player-bob').connected = false;
  room.battle.turn = 1; // bob's turn, bob offline
  const swap = findValidSwap(room.battle.board);
  await room.move(alice, { from: swap[0], to: swap[1] });
  const err = lastError(alice.socket);
  console.log('[A] poki offline-turn takeover:', err ? `FAILED (${err.message})` : `OK — turn moved to ${room.battle.turn} (alice took over)`);
}

// BUG B: xo — opponent offline on their turn → stuck
{
  const room = await makeRoom(XoRoom);
  const alice = { socket: createSocket(), id: 'player-alice' };
  const bob = { socket: createSocket(), id: 'player-bob' };
  await room.join(alice, { id: 'player-alice', name: 'Alice' });
  await room.join(bob, { id: 'player-bob', name: 'Bob' });
  attach(room, alice); attach(room, bob);
  await room.move(alice, { cell: 0 }); // turn=1 → bob's turn
  room.game.players.find((p) => p.id === 'player-bob').connected = false;
  await room.move(alice, { cell: 1 });
  const err = lastError(alice.socket);
  console.log('[B] xo offline-turn takeover:', err ? `FAILED (${err.message})` : `OK — board now ${room.game.board.slice(0, 3).join('')} (alice took over)`);
}

// BUG C: tienlen — a player disconnects mid-game on their turn → game stuck
{
  const room = await makeRoom(Room);
  const alice = { socket: createSocket(), playerId: null };
  const bob = { socket: createSocket(), playerId: null };
  await room.join(alice, { id: 'player-alice', name: 'Alice', avatar: 1 });
  await room.join(bob, { id: 'player-bob', name: 'Bob', avatar: 1 });
  attach(room, alice); attach(room, bob);
  do { room.room.game = dealGame(room.gamePlayers()); } while (!room.room.game.players[0].hand.includes('3s'));
  room.room.phase = 'game';
  await room.play(alice, ['3s']); // alice leads 3♠ → turn now bob (1)
  room.room.players.find((p) => p.id === 'player-bob').connected = false;
  const nextCard = room.room.game.players[0].hand[0];
  await room.play(alice, [nextCard]); // bob offline → auto-pass → alice gets the turn
  const err = lastError(alice.socket);
  console.log('[C] tienlen offline-turn skip:', err ? `FAILED (${err.message})` : `OK — turn ${room.room.game.turnIndex} after alice played (bob auto-passed)`);
}

// BUG C2: tienlen — offline player must LEAD (no current play) → skipLead keeps game going
{
  const room = await makeRoom(Room);
  const alice = { socket: createSocket(), playerId: null };
  const bob = { socket: createSocket(), playerId: null };
  await room.join(alice, { id: 'player-alice', name: 'Alice', avatar: 1 });
  await room.join(bob, { id: 'player-bob', name: 'Bob', avatar: 1 });
  attach(room, alice); attach(room, bob);
  do { room.room.game = dealGame(room.gamePlayers()); } while (!room.room.game.players[0].hand.includes('3s'));
  room.room.phase = 'game';
  room.room.players.find((p) => p.id === 'player-bob').connected = false;
  room.room.game.turnIndex = 1; // bob must lead but is offline
  await room.play(alice, ['3s']); // skipLead hands the lead to alice
  const err = lastError(alice.socket);
  console.log('[C2] tienlen offline leader skip:', err ? `FAILED (${err.message})` : `OK — alice led (turn ${room.room.game.turnIndex})`);
}

// BUG D: public worker accepts ARBITRARY /api/room/ codes → unlimited DO creation
{
  const req = new Request('https://game.test/api/room/ZZZZ9999', { headers: { Upgrade: 'websocket' } });
  const hit = [];
  const env = { ROOMS: { idFromName: (code) => { hit.push(code); return { fetch: async () => new Response('x') }; } } };
  const { default: worker } = await import('../worker/index.js');
  const res = await worker.fetch(req, env);
  console.log('[D] arbitrary room code ZZZZ9999 →', res.status === 404 ? `REJECTED 404 — ok` : `STATUS ${res.status} (${hit.length ? 'DO CREATED' : ''}) — BUG`);
}
