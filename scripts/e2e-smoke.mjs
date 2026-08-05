// Temporary E2E smoke test against the dev mock server (real AccountStore + PokiRoom code).
import { validMoves } from '../poki/public/game.js';

const BASE = 'http://localhost:8798';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function register(username) {
  const response = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, displayName: username.toUpperCase(), password: 'secret-123' }),
  });
  if (response.status !== 201) throw new Error(`register ${username} failed: ${response.status}`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { user: (await response.json()).user, cookie };
}

function openBattle(cookie, code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8798/api/poki/room/${code}`, { headers: { Cookie: cookie } });
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

const alice = await register('e2ealpha');
const bob = await register('e2ebeta');

const roomsResponse = await fetch(`${BASE}/api/poki/rooms`);
const rooms = (await roomsResponse.json()).rooms;
console.log('rooms:', rooms.map((room) => `${room.code}:${room.players}/2 ${room.phase}`).join(', '));
if (rooms.length !== 5) throw new Error(`expected 5 tables, got ${rooms.length}`);
if (!rooms.every((room) => room.maxPlayers === 2)) throw new Error('tables must be 1v1 (max 2)');

// rooms listing with alice's cookie (after joining, canJoin should stay true for her)
const aliceRoom = await openBattle(alice.cookie, 'POKI01');
const aliceState = await waitFor(aliceRoom.received, (m) => m.type === 'state', 'alice initial state');
aliceRoom.ws.send(JSON.stringify({ type: 'join', monster: 'emberfox' }));
const aliceJoined = await waitFor(aliceRoom.received, (m) => m.type === 'state' && m.battle.players.length === 1, 'alice joined');
console.log('alice joined POKI01:', aliceJoined.battle.players.map((p) => `${p.name}:${p.monster}`).join(', '));

const bobRoom = await openBattle(bob.cookie, 'POKI01');
bobRoom.ws.send(JSON.stringify({ type: 'join', monster: 'stonehorn' }));
const both = await waitFor(bobRoom.received, (m) => m.type === 'state' && m.battle.players.length === 2, 'both players present');
console.log('battle started — turn:', both.battle.turn, 'players:', both.battle.players.map((p) => p.monster).join(' vs '));

const move = validMoves(both.battle.board)[0];
console.log('alice moves', JSON.stringify(move));
aliceRoom.ws.send(JSON.stringify({ type: 'move', from: move.from, to: move.to }));
const afterMove = await waitFor(both.battle && bobRoom.received, (m) => m.type === 'state' && m.battle.lastAction?.player === alice.user.id, 'bob sees alice move');
console.log('turn advanced to', afterMove.battle.turn, '| lastAction damage:', afterMove.battle.lastAction.damage, 'cleared:', afterMove.battle.lastAction.cleared);

// bob tries to move out of turn → error
bobRoom.ws.send(JSON.stringify({ type: 'move', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }));
await waitFor(bobRoom.received, (m) => m.type === 'error', 'bob out-of-turn error');
console.log('out-of-turn move rejected: OK');

// alice leaves; bob should see the table return to waiting
aliceRoom.ws.send(JSON.stringify({ type: 'leave' }));
await waitFor(bobRoom.received, (m) => m.type === 'state' && m.battle.players.length === 1, 'bob waiting again');
console.log('alice left — table back to 1 player');

// third player cannot join a full 2/2 table elsewhere? test POKI02 full rejection
const carolRoom = await openBattle(alice.cookie, 'POKI02');
const daveRoom = await openBattle(bob.cookie, 'POKI02');
carolRoom.ws.send(JSON.stringify({ type: 'join', monster: 'miubeo' }));
await waitFor(carolRoom.received, (m) => m.type === 'state' && m.battle.players.length === 1, 'carol in POKI02');
daveRoom.ws.send(JSON.stringify({ type: 'join', monster: 'tidefin' }));
await waitFor(daveRoom.received, (m) => m.type === 'state' && m.battle.players.length === 2, 'dave in POKI02');
const eve = await register('e2eeve');
const eveRoom = await openBattle(eve.cookie, 'POKI02');
eveRoom.ws.send(JSON.stringify({ type: 'join', monster: 'voltwing' }));
const eveError = await waitFor(eveRoom.received, (m) => m.type === 'error', 'eve rejected');
console.log('third player rejected from full table:', eveError.message, '| fatal:', eveError.fatal);

aliceRoom.ws.close();
bobRoom.ws.close();
carolRoom.ws.close();
daveRoom.ws.close();
eveRoom.ws.close();
console.log('\nE2E SMOKE PASSED ✅');
