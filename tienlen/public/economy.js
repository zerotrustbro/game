export const STARTING_COINS = 100;
export const LOSS_PENALTY = 10;

export function settleCoins(balances, winnerId, loserIds, penalty = LOSS_PENALTY) {
  const ids = [...new Set(loserIds.map(String).filter((id) => id && id !== winnerId))];
  if (balances[winnerId] === undefined || ids.some((id) => balances[id] === undefined)) return { ok: false, changes: [], balances: { ...balances } };
  const next = { ...balances };
  const changes = [];
  let collected = 0;
  for (const loserId of ids) {
    const amount = -Math.min(penalty, Math.max(0, next[loserId]));
    next[loserId] += amount;
    collected -= amount;
    changes.push({ userId: loserId, amount });
  }
  next[winnerId] += collected;
  changes.push({ userId: winnerId, amount: collected });
  return { ok: true, changes, balances: next };
}
