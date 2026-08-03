import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../worker/index.js';

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
