// XO — Tic-Tac-Toe core rules. Pure logic, shared by the Worker (XoRoom) and the browser client.

export const SIZE = 3;
export const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

export function emptyBoard() {
  return Array(9).fill(null);
}

export function initialGame() {
  return { board: emptyBoard(), players: [], turn: 0, gameOver: false, winner: null, draw: false, lastMove: null };
}

export function addPlayer(game, player) {
  if (game.players.some((p) => p.id === player.id) || game.players.length >= 2) return game;
  const symbol = game.players.length === 0 ? 'X' : 'O';
  return { ...game, players: [...game.players, { id: player.id, name: player.name, symbol, connected: player.connected !== false }] };
}

export function evaluateBoard(board, players) {
  const line = WIN_LINES.find((candidate) => candidate.every((index) => board[index] && board[index] === board[candidate[0]]));
  const symbol = line && board[line[0]];
  const winner = symbol ? players.find((player) => player.symbol === symbol)?.id || null : null;
  const draw = !winner && board.every(Boolean);
  return { gameOver: Boolean(winner || draw), winner, draw };
}

export function makeMove(game, playerId, cell) {
  // Strict coercion guard: null, booleans, strings and arrays must never
  // silently become cell 0.
  if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell >= SIZE * SIZE) return { ok: false, error: 'Ô không hợp lệ.' };
  if (game.gameOver) return { ok: false, error: 'Trận đã kết thúc.' };
  if (game.board[cell]) return { ok: false, error: 'Ô này đã được đánh.' };
  const player = game.players[game.turn % Math.max(1, game.players.length)];
  if (!player || player.id !== playerId) return { ok: false, error: 'Chưa đến lượt bạn.' };
  const symbol = player.symbol;
  const board = [...game.board];
  board[cell] = symbol;
  const result = evaluateBoard(board, game.players);
  return {
    ok: true,
    game: {
      ...game,
      board,
      turn: game.turn + 1,
      gameOver: result.gameOver,
      winner: result.winner,
      draw: result.draw,
      lastMove: { player: playerId, cell, symbol },
    },
  };
}


