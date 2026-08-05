// E2E smoke test against the dev mock server (real Room + PokiRoom + XoRoom code).
// Usage: node scripts/dev-mock.mjs  (in another terminal)  →  node scripts/e2e-smoke.mjs
import { validMoves } from '../poki/public/game.js';

const BASE = 'http://localhost:8798';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const playerId = () => crypto.randomUUID();

function openBattle(path, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8798${path}${query ? `?${query}` : ''}`);
    const received = [];
    ws.onopen = () => resolve({ ws, received });
    ws.onerror = (error) => reject(error);
    ws.onmessage = (event) => received.push(JSON.parse(event.data));
  });
}

const waitFor = async (received, predicate, label, timeoutMs = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = received.find(predicate);
    if (match) return match;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}; got ${JSON.stringify(received.map((m) => m.type))}`);
};

// ---- Poki 1v1 ----
{
  const roomsResponse = await fetch(`${BASE}/api/poki/rooms`);
  const rooms = (await roomsResponse.json()).rooms;
  console.log('poki rooms:', rooms.map((room) => `${room.code}:${room.players}/2`).join(', '));
  if (rooms.length !== 5 || !rooms.every((room) => room.maxPlayers === 2)) throw new Error('poki must expose 5× 1v1 tables');

  const alice = await openBattle('/api/poki/room/POKI01');
  alice.ws.send(JSON.stringify({ type: 'join', id: playerId(), name: 'Alice', monster: 'emberfox' }));
  const aliceJoined = await waitFor(alice.received, (m) => m.type === 'state' && m.battle.players.length === 1, 'alice joined');
  console.log('alice joined POKI01:', aliceJoined.battle.players[0].name);

  const bob = await openBattle('/api/poki/room/POKI01');
  bob.ws.send(JSON.stringify({ type: 'join', id: playerId(), name: 'Bob', monster: 'stonehorn' }));
  const both = await waitFor(bob.received, (m) => m.type === 'state' && m.battle.players.length === 2, 'bob joined');
  console.log('poki battle started:', both.battle.players.map((p) => p.name).join(' vs '));

  const move = validMoves(both.battle.board)[0];
  alice.ws.send(JSON.stringify({ type: 'move', from: move.from, to: move.to }));
  const afterMove = await waitFor(bob.received, (m) => m.type === 'state' && m.battle.lastAction?.player === aliceJoined.you, 'bob sees alice move');
  console.log('poki move ok — turn', afterMove.battle.turn, '| damage:', afterMove.battle.lastAction.damage);

  bob.ws.send(JSON.stringify({ type: 'move', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }));
  await waitFor(bob.received, (m) => m.type === 'error', 'out-of-turn rejected');
  console.log('out-of-turn rejected: OK');

  alice.ws.send(JSON.stringify({ type: 'leave' }));
  await waitFor(bob.received, (m) => m.type === 'state' && m.battle.players.length === 1, 'alice left');
  alice.ws.close(); bob.ws.close();
}

// ---- XO ----
{
  const roomsResponse = await fetch(`${BASE}/api/xo/rooms`);
  const rooms = (await roomsResponse.json()).rooms;
  console.log('xo rooms:', rooms.map((room) => `${room.code}:${room.players}/2`).join(', '));
  if (rooms.length !== 5) throw new Error('xo must expose 5 tables');

  const alice = await openBattle('/api/xo/room/XO01');
  alice.ws.send(JSON.stringify({ type: 'join', id: playerId(), name: 'Alice' }));
  await waitFor(alice.received, (m) => m.type === 'state' && m.game.players.length === 1, 'alice in XO01');

  const bob = await openBattle('/api/xo/room/XO01');
  bob.ws.send(JSON.stringify({ type: 'join', id: playerId(), name: 'Bob' }));
  const start = await waitFor(bob.received, (m) => m.type === 'state' && m.game.players.length === 2, 'bob in XO01');
  console.log('xo symbols:', start.game.players.map((p) => `${p.name}:${p.symbol}`).join(' '));

  alice.ws.send(JSON.stringify({ type: 'move', cell: 0 }));
  await waitFor(bob.received, (m) => m.type === 'state' && m.game.board[0] === 'X', 'X placed');
  bob.ws.send(JSON.stringify({ type: 'move', cell: 0 }));
  await waitFor(bob.received, (m) => m.type === 'error', 'occupied cell rejected');
  bob.ws.send(JSON.stringify({ type: 'move', cell: 3 }));
  await waitFor(alice.received, (m) => m.type === 'state' && m.game.board[3] === 'O', 'O placed');
  console.log('xo moves ok');

  alice.ws.send(JSON.stringify({ type: 'leave' }));
  await waitFor(bob.received, (m) => m.type === 'state' && m.game.players.length === 1, 'alice left XO');
  alice.ws.close(); bob.ws.close();
}

// ---- Tiến Lên lobby (nickname join) ----
{
  const roomsResponse = await fetch(`${BASE}/api/rooms`);
  const rooms = (await roomsResponse.json()).rooms;
  console.log('tienlen rooms:', rooms.map((room) => `${room.code}:${room.players}/4`).join(', '));
  if (rooms.length !== 5) throw new Error('tienlen must expose 5 tables');

  const alice = await openBattle('/api/room/BAN01');
  alice.ws.send(JSON.stringify({ type: 'join', id: playerId(), name: 'Alice', avatar: 1 }));
  const joined = await waitFor(alice.received, (m) => m.type === 'state' && m.players.length === 1, 'alice in BAN01');
  console.log('tienlen join ok —', joined.players[0].name, '| phase:', joined.phase);
  alice.ws.send(JSON.stringify({ type: 'start' }));
  const blocked = await waitFor(alice.received, (m) => m.type === 'error', 'start blocked with 1 player');
  if (!/ít nhất 2 người/.test(blocked.message)) throw new Error(`unexpected start error: ${blocked.message}`);
  console.log('tienlen start blocked with 1 player (need 2+): OK');
  alice.ws.close();
}

console.log('\nE2E SMOKE PASSED ✅');
