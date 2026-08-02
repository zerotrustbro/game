import test from 'node:test';
import assert from 'node:assert/strict';
import { LOSS_PENALTY, settleCoins } from '../tienlen/public/economy.js';

test('new account economy starts with a shared xu balance and settles losses', () => {
  const result = settleCoins({ winner: 100, loserA: 100, loserB: 4 }, 'winner', ['loserA', 'loserB']);
  assert.equal(LOSS_PENALTY, 10);
  assert.equal(result.ok, true);
  assert.deepEqual(result.balances, { winner: 114, loserA: 90, loserB: 0 });
  assert.deepEqual(result.changes, [
    { userId: 'loserA', amount: -10 },
    { userId: 'loserB', amount: -4 },
    { userId: 'winner', amount: 14 },
  ]);
});

test('settlement is rejected when an account is missing', () => {
  const result = settleCoins({ winner: 100 }, 'winner', ['missing']);
  assert.equal(result.ok, false);
});
