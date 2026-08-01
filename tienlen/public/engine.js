const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['s', 'c', 'd', 'h']; // bích, chuồn, rô, cơ
const SUIT_ORDER = Object.fromEntries(SUITS.map((suit, index) => [suit, index]));
const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index]));

export const CARD_RANKS = RANKS;
export const CARD_SUITS = SUITS;

export function cardRank(card) {
  return String(card).slice(0, -1);
}

export function cardSuit(card) {
  return String(card).slice(-1);
}

export function cardValue(card) {
  return RANK_VALUE[cardRank(card)] ?? -1;
}

export function cardSort(a, b) {
  return cardValue(a) - cardValue(b) || SUIT_ORDER[cardSuit(a)] - SUIT_ORDER[cardSuit(b)];
}

export function createDeck() {
  return RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}`));
}

export function describeCombo(cards) {
  const sorted = [...new Set(cards)].sort(cardSort);
  if (!sorted.length || sorted.length !== cards.length) return { type: 'invalid', cards: sorted };

  const ranks = sorted.map(cardRank);
  const counts = Object.values(ranks.reduce((all, rank) => {
    all[rank] = (all[rank] || 0) + 1;
    return all;
  }, {})).sort((a, b) => b - a);
  const uniqueValues = [...new Set(sorted.map(cardValue))];
  const sameRank = counts.length === 1;
  const isStraight = sorted.length >= 3
    && counts.every((count) => count === 1)
    && uniqueValues.every((value, index) => index === 0 || value === uniqueValues[index - 1] + 1)
    && !ranks.includes('2');
  const isPairSequence = sorted.length >= 4
    && sorted.length % 2 === 0
    && counts.every((count) => count === 2)
    && uniqueValues.length === sorted.length / 2
    && uniqueValues.every((value, index) => index === 0 || value === uniqueValues[index - 1] + 1)
    && !ranks.includes('2');

  if (sorted.length === 1) return { type: 'single', length: 1, high: cardValue(sorted[0]), cards: sorted };
  if (sameRank && sorted.length === 2) return { type: 'pair', length: 2, high: cardValue(sorted[0]), cards: sorted };
  if (sameRank && sorted.length === 3) return { type: 'triple', length: 3, high: cardValue(sorted[0]), cards: sorted };
  if (sameRank && sorted.length === 4) return { type: 'four', length: 4, high: cardValue(sorted[0]), cards: sorted };
  if (isPairSequence) return { type: 'pairseq', length: sorted.length, high: uniqueValues.at(-1), cards: sorted };
  if (isStraight) return { type: 'straight', length: sorted.length, high: uniqueValues.at(-1), cards: sorted };
  return { type: 'invalid', cards: sorted };
}

export function canBeat(next, previous) {
  if (!next || next.type === 'invalid') return false;
  if (!previous) return true;
  if (next.type === previous.type && next.length === previous.length) return next.high > previous.high;
  if (next.type === 'four' && previous.type === 'single' && cardRank(previous.cards[0]) === '2') return true;
  if (next.type === 'pairseq' && next.length >= 6 && previous.type === 'single' && cardRank(previous.cards[0]) === '2') return true;
  return false;
}

function nextPlayerIndex(game, fromIndex = game.turnIndex) {
  return (fromIndex + 1) % game.players.length;
}

function playerIndex(game, playerId) {
  return game.players.findIndex((player) => player.id === playerId);
}

function hasAllCards(player, cards) {
  const hand = [...player.hand];
  return cards.every((card) => {
    const index = hand.indexOf(card);
    if (index < 0) return false;
    hand.splice(index, 1);
    return true;
  });
}

export function createGame(players, options = {}) {
  const normalized = players.map((player) => ({
    id: String(player.id),
    name: String(player.name || 'Người chơi'),
    avatar: Number.isInteger(player.avatar) ? player.avatar : 1,
    hand: [...(player.hand || [])].sort(cardSort),
  }));
  const firstThree = normalized.findIndex((player) => player.hand.includes('3s'));
  return {
    players: normalized,
    turnIndex: options.turnIndex ?? (firstThree >= 0 ? firstThree : 0),
    currentPlay: null,
    passCount: 0,
    mustStart: options.mustStart ?? false,
    gameOver: false,
    winner: null,
    startedAt: options.startedAt || Date.now(),
  };
}

export function dealGame(players, random = Math.random) {
  const deck = createDeck();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return createGame(players.map((player, index) => ({
    ...player,
    hand: deck.slice(index * 13, index * 13 + 13),
  })), { mustStart: true });
}

export function playMove(game, playerId, cards) {
  if (game.gameOver) return { ok: false, error: 'Ván đã kết thúc.' };
  const index = playerIndex(game, playerId);
  if (index < 0) return { ok: false, error: 'Không tìm thấy người chơi.' };
  if (index !== game.turnIndex) return { ok: false, error: 'Chưa tới lượt bạn.' };
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > 13) return { ok: false, error: 'Nước đánh không hợp lệ.' };

  const player = game.players[index];
  if (!hasAllCards(player, cards)) return { ok: false, error: 'Bạn không sở hữu đủ những lá đã chọn.' };
  const combo = describeCombo(cards);
  if (combo.type === 'invalid') return { ok: false, error: 'Bộ bài này không hợp lệ.' };
  if (game.mustStart && !game.currentPlay && !cards.includes('3s')) {
    return { ok: false, error: 'Ván mới phải bắt đầu bằng 3 bích.' };
  }
  if (!canBeat(combo, game.currentPlay?.combo || null)) {
    return { ok: false, error: 'Bộ bài này không đè được bộ trước.' };
  }

  const next = structuredClone(game);
  next.players[index].hand = player.hand.filter((card) => !cards.includes(card)).sort(cardSort);
  next.currentPlay = { playerId, combo, cards: [...combo.cards] };
  next.passCount = 0;
  next.mustStart = false;
  if (next.players[index].hand.length === 0) {
    next.gameOver = true;
    next.winner = playerId;
    return { ok: true, game: next, action: { type: 'play', playerId, cards: combo.cards, combo, terminal: true } };
  }
  next.turnIndex = nextPlayerIndex(next, index);
  return { ok: true, game: next, action: { type: 'play', playerId, cards: combo.cards, combo, terminal: false } };
}

export function passMove(game, playerId) {
  if (game.gameOver) return { ok: false, error: 'Ván đã kết thúc.' };
  const index = playerIndex(game, playerId);
  if (index < 0) return { ok: false, error: 'Không tìm thấy người chơi.' };
  if (index !== game.turnIndex) return { ok: false, error: 'Chưa tới lượt bạn.' };
  if (!game.currentPlay) return { ok: false, error: 'Bạn phải đánh bài khi bắt đầu vòng.' };

  const next = structuredClone(game);
  next.passCount += 1;
  const activeOpponents = next.players.length - 1;
  if (next.passCount >= activeOpponents) {
    const lastPlayerIndex = playerIndex(next, next.currentPlay.playerId);
    next.currentPlay = null;
    next.passCount = 0;
    next.turnIndex = lastPlayerIndex;
  } else {
    next.turnIndex = nextPlayerIndex(next, index);
  }
  return { ok: true, game: next, action: { type: 'pass', playerId, reset: next.currentPlay === null } };
}

export function describeComboForUi(combo) {
  const names = {
    single: 'Lá lẻ', pair: 'Đôi', triple: 'Sám', straight: 'Sảnh', four: 'Tứ quý', pairseq: 'Đôi thông',
  };
  return names[combo?.type] || 'Bộ bài';
}

export const describeComboName = describeComboForUi;
