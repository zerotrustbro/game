import { isXoRoomCode, xoGamePath, xoRoomUrl, xoTableLabel, XO_ROOM_CODES } from './routes.js';

const $ = (id) => document.getElementById(id);
const lobbyView = $('lobbyView');
const battleView = $('battleView');
const roomList = $('roomList');
const toast = $('toast');
const playerName = $('playerName');
const topNick = $('nickname');

const id = localStorage.getItem('player-id') || crypto.randomUUID();
localStorage.setItem('player-id', id);

let socket = null;
let rooms = [];
let game = null; // { players, board, turn, gameOver, winner, draw, lastMove }
let selectedTable = '';
let sound = localStorage.getItem('xo-sound') !== 'off';

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}

function nickname() {
  return (localStorage.getItem('game-nick') || '').trim().slice(0, 18) || 'Người chơi';
}

function saveNickname(value) {
  localStorage.setItem('game-nick', value.trim().slice(0, 18));
  playerName.value = value.trim().slice(0, 18);
  topNick.value = value.trim().slice(0, 18);
}

function showToast(message, tone = '') {
  toast.textContent = message;
  toast.className = `toast visible ${tone}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function renderRoomList() {
  if (!rooms.length) {
    roomList.innerHTML = '<p class="room-list-loading">Chưa tải được danh sách bàn. Thử tải lại trang.</p>';
    return;
  }
  roomList.innerHTML = rooms.map((table, index) => {
    const players = Math.max(0, Number(table.players) || 0);
    const canJoin = Boolean(table.canJoin);
    const status = table.phase === 'unavailable'
      ? 'TẠM LỖI'
      : table.gameOver
        ? (players >= 2 ? 'KẾT THÚC' : 'KẾT THÚC · CÒN CHỖ')
        : players >= 2 ? 'ĐANG ĐẤU' : players === 1 ? 'CHỜ ĐỐI THỦ' : 'CÒN CHỖ';
    const isSelected = selectedTable === table.code;
    return `<button class="room-choice ${canJoin ? '' : 'locked'} ${isSelected ? 'selected' : ''}" type="button" data-room-code="${esc(table.code)}" ${canJoin ? '' : 'disabled'}><span class="room-choice-index">0${index + 1}</span><span class="room-choice-copy"><b>${xoTableLabel(index)}</b><small>${players}/2 người · ${status}</small></span><span class="room-choice-status">${status}</span></button>`;
  }).join('');
  roomList.querySelectorAll('[data-room-code]').forEach((button) => {
    button.onclick = () => { selectedTable = button.dataset.roomCode; renderRoomList(); };
  });
}

async function loadRooms() {
  try {
    const response = await fetch(`/api/xo/rooms?pid=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('room list unavailable');
    const data = await response.json();
    rooms = Array.isArray(data.rooms) ? data.rooms : [];
  } catch {
    rooms = [];
  }
  renderRoomList();
}

function showLobby() {
  socket?.close();
  socket = null;
  game = null;
  lobbyView.classList.remove('hidden');
  battleView.classList.add('hidden');
  const requested = new URLSearchParams(location.search).get('room') || '';
  if (isXoRoomCode(requested)) selectedTable = requested.toUpperCase();
  renderRoomList();
}

function connect(code) {
  selectedTable = code.toUpperCase();
  history.replaceState({}, '', xoRoomUrl(selectedTable));
  socket?.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/api/xo/room/${selectedTable}`);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'join', id, name: nickname() }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'error') {
      showToast(message.message, 'error');
      if (message.fatal) { socket?.close(); socket = null; game = null; history.replaceState({}, '', xoGamePath()); showLobby(); }
      return;
    }
    if (message.type !== 'state') return;
    game = message.game;
    lobbyView.classList.add('hidden');
    battleView.classList.remove('hidden');
    $('roomCodeLabel').textContent = message.roomCode;
    render();
  });
  socket.addEventListener('close', () => {
    if (game) setTimeout(() => { if (socket?.readyState === WebSocket.CLOSED) connect(selectedTable); }, 1600);
  });
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return showToast('Kết nối chưa sẵn sàng.', 'error');
  socket.send(JSON.stringify(message));
}

function myPlayer() {
  return game?.players.find((player) => player.id === id);
}

function render() {
  if (!game) return;
  const me = myPlayer();
  const foe = game.players.find((player) => player.id !== id);
  const active = game.players[game.turn % Math.max(1, game.players.length)];
  const mine = active?.id === id;
  $('players').innerHTML = game.players.map((player) => {
    const local = player.id === id;
    const current = active?.id === player.id && !game.gameOver;
    return `<div class="player-chip ${local ? 'local' : ''} ${current ? 'turn' : ''}"><b class="symbol ${player.symbol.toLowerCase()}">${player.symbol}</b><span>${esc(player.name)}${local ? ' (bạn)' : ''}${player.connected ? '' : ' · mất kết nối'}</span></div>`;
  }).join('') || '<div class="player-chip"><b class="symbol x">✕</b><span>Chờ đối thủ…</span></div>';
  $('battleTitle').textContent = game.gameOver
    ? (game.draw ? 'Hòa cờ' : (game.winner === id ? 'Bạn thắng!' : `${esc(game.players.find((p) => p.id === game.winner)?.name || 'Đối thủ')} thắng`))
    : game.players.length < 2 ? 'Đang chờ người chơi' : mine ? 'Đến lượt bạn' : 'Đến lượt đối thủ';
  $('board').innerHTML = game.board.map((cell, index) => `<button class="cell ${cell ? cell.toLowerCase() : ''} ${game.lastMove?.cell === index ? 'last' : ''}" data-cell="${index}" ${cell || game.gameOver || game.players.length < 2 || !mine ? 'disabled' : ''}><span>${cell === 'X' ? '✕' : cell === 'O' ? '○' : ''}</span></button>`).join('');
  $('turnLine').textContent = game.gameOver
    ? (game.draw ? 'Bàn cờ kín — không ai thắng. Đấu lại nhé!' : `Người thắng: ${esc(game.players.find((p) => p.id === game.winner)?.name || '?')}`)
    : game.players.length < 2 ? 'Mời thêm một người vào bàn để bắt đầu.' : mine ? 'Chọn một ô trống để đánh.' : `Đang chờ ${esc(active?.name || 'đối thủ')}…`;
  $('rematchButton').classList.toggle('hidden', !game.gameOver || !me);
}

$('board').addEventListener('click', (event) => {
  const button = event.target.closest('[data-cell]');
  if (!button || button.disabled) return;
  send({ type: 'move', cell: Number(button.dataset.cell) });
});
roomList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-room-code]');
  if (!button || button.disabled) return;
  if (playerName.value.trim()) saveNickname(playerName.value);
  connect(button.dataset.roomCode);
});
playerName.addEventListener('input', () => saveNickname(playerName.value));
topNick.addEventListener('input', () => saveNickname(topNick.value));
playerName.addEventListener('keydown', (event) => { if (event.key === 'Enter') roomList.querySelector('.room-choice:not(:disabled)')?.click(); });
topNick.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !lobbyView.classList.contains('hidden')) roomList.querySelector('.room-choice:not(:disabled)')?.click(); });
$('rematchButton').addEventListener('click', () => send({ type: 'restart' }));
$('leaveButton').addEventListener('click', () => {
  if (socket?.readyState === WebSocket.OPEN) send({ type: 'leave' });
  socket?.close();
  socket = null;
  game = null;
  history.replaceState({}, '', xoGamePath());
  showLobby();
});
$('soundButton').addEventListener('click', () => {
  sound = !sound;
  localStorage.setItem('xo-sound', sound ? 'on' : 'off');
  $('soundButton').textContent = sound ? '◖' : '◌';
});

playerName.value = localStorage.getItem('game-nick') || '';
topNick.value = playerName.value;
$('soundButton').textContent = sound ? '◖' : '◌';
loadRooms();
setInterval(() => {
  if (!lobbyView.classList.contains('hidden')) loadRooms();
}, 5000);
showLobby();
