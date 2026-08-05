import { cardRank, cardSort, cardSuit } from './engine.js';
import { gamePath, isRoomCode, parseRoute, roomPath } from './routes.js';

const AVATARS = Array.from({ length: 8 }, (_, index) => `/assets/avatars/avatar-${String(index + 1).padStart(2, '0')}.webp`);
const SUIT_NAMES = { s: 'bích', c: 'chuồn', d: 'rô', h: 'cơ' };
const SUIT_MARKS = { s: '♠', c: '♣', d: '♦', h: '♥' };
const SUIT_CLASS = { s: 'black', c: 'black', d: 'red', h: 'red' };
const state = {
  socket: null,
  roomCode: '',
  playerId: null,
  id: localStorage.getItem('player-id') || crypto.randomUUID(),
  name: localStorage.getItem('game-nick') || '',
  avatar: Number(localStorage.getItem('tienlen-avatar') || 1),
  room: null,
  rooms: [],
  roomsLoading: false,
  selected: new Set(),
  sound: localStorage.getItem('tienlen-sound') !== 'off',
  allowReconnect: false,
  reconnectTimer: null,
};

const $ = (id) => document.getElementById(id);
const hubView = $('hubView');
const gameLobbyView = $('gameLobbyView');
const roomView = $('roomView');
const playerName = $('playerName');
const topNick = $('nickname');
const avatarPicker = $('avatarPicker');
const roomList = $('roomList');
const toast = $('toast');
const connectionDot = $('connectionDot');
const connectionText = $('connectionText');
const initialRoute = parseRoute(location.pathname);
let pendingRoomCode = null;

localStorage.setItem('player-id', state.id);
playerName.value = state.name;
topNick.value = state.name;
$('soundButton').textContent = state.sound ? '◖' : '◌';

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}

function showToast(message, tone = '') {
  toast.textContent = message;
  toast.className = `toast visible ${tone}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function setConnection(label, connected = false) {
  connectionText.textContent = label;
  connectionDot.className = `connection-dot ${connected ? 'online' : ''}`;
}

function saveNickname(value) {
  state.name = value.trim().slice(0, 18);
  localStorage.setItem('game-nick', state.name);
  playerName.value = state.name;
  topNick.value = state.name;
}

function renderRoomList() {
  if (!state.rooms.length) {
    roomList.innerHTML = '<p class="room-list-loading">Chưa tải được danh sách bàn. Thử tải lại trang.</p>';
    return;
  }
  roomList.innerHTML = state.rooms.map((table, index) => {
    const players = Math.max(0, Number(table.players) || 0);
    const maxPlayers = Math.max(2, Number(table.maxPlayers) || 4);
    const canJoin = Boolean(table.canJoin);
    const status = table.phase === 'unavailable'
      ? 'TẠM LỖI'
      : table.phase === 'game'
        ? (canJoin ? 'VÀO LẠI' : 'ĐANG CHƠI')
        : players >= maxPlayers ? 'ĐỦ NGƯỜI' : 'CÒN CHỖ';
    return `<button class="room-choice ${canJoin ? '' : 'locked'}" type="button" data-room-code="${esc(table.code)}" ${canJoin ? '' : 'disabled'}><span class="room-choice-index">0${index + 1}</span><span class="room-choice-copy"><b>Bàn ${index + 1}</b><small>${players}/${maxPlayers} người · ${table.phase === 'game' ? 'ván đang diễn ra' : 'đang chờ'}</small></span><span class="room-choice-status">${status}</span></button>`;
  }).join('');
}

async function loadRooms() {
  if (state.roomsLoading) return;
  state.roomsLoading = true;
  try {
    const response = await fetch(`/api/rooms?pid=${encodeURIComponent(state.id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('room list unavailable');
    const data = await response.json();
    state.rooms = Array.isArray(data.rooms) ? data.rooms : [];
  } catch {
    state.rooms = [];
  } finally {
    state.roomsLoading = false;
  }
  renderRoomList();
}

function cancelReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function scheduleReconnect(code) {
  cancelReconnect();
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.allowReconnect && state.roomCode === code) connect(code);
  }, 1600);
}

function connect(code, { push = false } = {}) {
  state.roomCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!isRoomCode(state.roomCode)) return showToast('Hãy chọn một trong năm bàn đang mở.', 'error');
  state.allowReconnect = true;
  cancelReconnect();
  history[push ? 'pushState' : 'replaceState']({}, '', roomPath(state.roomCode));
  if (state.socket) state.socket.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/room/${state.roomCode}`);
  state.socket = socket;
  setConnection('Đang kết nối…');
  socket.addEventListener('open', () => {
    if (state.socket !== socket) return;
    setConnection('Đã kết nối', true);
    socket.send(JSON.stringify({ type: 'join', id: state.id, name: state.name || 'Người chơi', avatar: state.avatar }));
  });
  socket.addEventListener('message', (event) => {
    if (state.socket !== socket) return;
    try {
      handleMessage(JSON.parse(event.data));
    } catch {
      showToast('Phản hồi từ phòng không hợp lệ.', 'error');
    }
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    setConnection('Mất kết nối');
    if (state.allowReconnect) scheduleReconnect(state.roomCode);
  });
  socket.addEventListener('error', () => {
    if (state.socket === socket) showToast('Không thể kết nối phòng này.', 'error');
  });
}

function send(message) {
  if (state.socket?.readyState !== WebSocket.OPEN) return showToast('Kết nối chưa sẵn sàng.', 'error');
  state.socket.send(JSON.stringify(message));
}

function handleMessage(message) {
  if (message.type === 'connected') return;
  if (message.type === 'error') {
    showToast(message.message, 'error');
    if (message.fatal) {
      history.replaceState({}, '', gamePath());
      showGameLobby();
    }
    return;
  }
  if (message.type !== 'state') return;
  if (message.you) {
    state.playerId = message.you;
    // Persist the server's canonical id so reconnects and room-list queries
    // use the same identity instead of a legacy id that gets remapped again.
    if (state.id !== message.you) {
      state.id = message.you;
      localStorage.setItem('player-id', state.id);
    }
  }
  state.room = message;
  state.selected.clear();
  hubView.classList.add('hidden');
  gameLobbyView.classList.add('hidden');
  roomView.classList.remove('hidden');
  $('roomCodeLabel').textContent = message.roomCode;
  renderRoom();
}

function showHub() {
  state.allowReconnect = false;
  cancelReconnect();
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'leave' }));
  state.socket?.close();
  state.socket = null;
  state.room = null;
  state.roomCode = '';
  hubView.classList.remove('hidden');
  gameLobbyView.classList.add('hidden');
  roomView.classList.add('hidden');
  setConnection('Chưa kết nối');
}

function showGameLobby(roomCode = null) {
  state.allowReconnect = false;
  cancelReconnect();
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'leave' }));
  state.socket?.close();
  state.socket = null;
  state.room = null;
  state.roomCode = '';
  hubView.classList.add('hidden');
  gameLobbyView.classList.remove('hidden');
  roomView.classList.add('hidden');
  setConnection('Chưa kết nối');
  const inviteNote = $('inviteNote');
  inviteNote.classList.toggle('hidden', !roomCode);
  inviteNote.textContent = roomCode ? `Bạn được mời vào phòng ${roomCode}. Chọn bàn ${roomCode} để vào.` : '';
  renderRoomList();
}

function applyRoute(route = parseRoute(location.pathname)) {
  if (route.page === 'hub') return showHub();
  if (route.page === 'tienlen') {
    showGameLobby(route.roomCode);
    if (route.roomCode) connect(route.roomCode);
    return;
  }
  showHub();
  showToast('Trang này chưa tồn tại.', 'error');
}

function renderAvatarPicker() {
  avatarPicker.innerHTML = AVATARS.map((src, index) => `<button class="avatar-choice ${state.avatar === index + 1 ? 'selected' : ''}" type="button" data-avatar="${index + 1}" aria-label="Chân dung ${index + 1}" aria-checked="${state.avatar === index + 1}"><img src="${src}" alt="" /></button>`).join('');
}

function seatMarkup(player, isLocal, isTurn) {
  if (!player) return `<div class="empty-seat"><span>+</span><small>Chờ người</small></div>`;
  const avatar = AVATARS[(player.avatar || 1) - 1] || AVATARS[0];
  return `<div class="player-seat ${isLocal ? 'local' : ''} ${isTurn ? 'turn' : ''} ${player.connected ? '' : 'offline'}"><div class="seat-avatar"><img src="${avatar}" alt="" />${isTurn ? '<i class="turn-ring"></i>' : ''}</div><div class="seat-meta"><b>${esc(player.name)}${isLocal ? ' <small>(bạn)</small>' : ''}</b><span>${player.handCount ? `${player.handCount} lá` : 'Chưa vào ván'}${player.connected ? '' : ' · mất kết nối'}</span></div></div>`;
}

function arrangeSeats(players) {
  const localIndex = Math.max(0, players.findIndex((player) => player.id === state.playerId));
  const ordered = players.length ? players.slice(localIndex).concat(players.slice(0, localIndex)) : [];
  return [ordered[1], ordered[2], ordered[3], ordered[0]];
}

function renderRoom() {
  const room = state.room;
  const players = room.players || [];
  const [top, left, right, bottom] = arrangeSeats(players);
  const isHost = room.hostId === state.playerId;
  const isTurn = room.turnPlayerId === state.playerId;
  $('seatTop').innerHTML = seatMarkup(top, false, top?.id === room.turnPlayerId);
  $('seatLeft').innerHTML = seatMarkup(left, false, left?.id === room.turnPlayerId);
  $('seatRight').innerHTML = seatMarkup(right, false, right?.id === room.turnPlayerId);
  $('seatBottom').innerHTML = seatMarkup(bottom, true, bottom?.id === room.turnPlayerId);
  $('lobbyPlayers').innerHTML = players.map((player) => `<span class="lobby-player ${player.connected ? '' : 'offline'}"><img src="${AVATARS[(player.avatar || 1) - 1]}" alt="" />${esc(player.name)}</span>`).join('');
  $('startButton').classList.toggle('hidden', room.phase !== 'lobby' || !isHost);
  $('rematchButton').classList.toggle('hidden', !room.gameOver || !isHost);
  $('roomTitle').textContent = room.gameOver ? `${room.winner === room.you ? 'Bạn thắng ván này' : 'Ván đã kết thúc'}` : room.phase === 'game' ? (isTurn ? 'Đến lượt bạn' : 'Đang trong ván') : 'Đang chờ người chơi';
  $('turnKicker').textContent = room.gameOver ? 'KẾT QUẢ' : room.phase === 'game' ? (isTurn ? 'LƯỢT CỦA BẠN' : `LƯỢT ${room.players.find((player) => player.id === room.turnPlayerId)?.name || ''}`) : 'PHÒNG CHỜ';
  renderCurrentPlay(room);
  $('tableStatus').textContent = room.gameOver ? `${room.winner === room.you ? 'Chúc mừng — bạn là người hết bài trước.' : `${room.players.find((player) => player.id === room.winner)?.name || 'Đối thủ'} đã thắng.`}` : room.phase === 'game' ? (isTurn ? 'Chọn bài trên tay rồi đánh.' : 'Theo dõi lượt của đối thủ.') : (players.length < 2 ? 'Cần ít nhất 2 người để bắt đầu.' : (isHost ? 'Bạn có thể bắt đầu ván.' : 'Đợi chủ phòng bắt đầu ván.'));
  renderHand(room, isTurn);
}

function renderCurrentPlay(room) {
  const current = room.currentPlay;
  $('pile').classList.toggle('hidden', Boolean(current));
  if (!current) {
    $('lastPlay').innerHTML = room.phase === 'game'
      ? '<span class="played-empty">Vòng mới — người vừa đánh được quyền dẫn</span>'
      : '<span class="played-empty">Mời thêm người chơi để bắt đầu</span>';
    return;
  }
  const playerNameText = esc(room.players.find((player) => player.id === current.playerId)?.name || 'Người chơi');
  const countClass = Math.min(current.cards.length, 8);
  $('lastPlay').innerHTML = `<div class="played-by"><b>${playerNameText}</b> vừa đánh</div><div class="played-cards count-${countClass}" aria-label="Bộ bài vừa đánh">${current.cards.map(tableCardMarkup).join('')}</div>`;
}

function tableCardMarkup(card, index) {
  const suit = cardSuit(card);
  const rank = cardRank(card);
  return `<div class="table-card ${SUIT_CLASS[suit]}" style="--i:${index}" aria-label="${esc(rank)} ${SUIT_NAMES[suit]}"><span class="card-corner top"><b>${esc(rank)}</b><i>${SUIT_MARKS[suit]}</i></span><span class="card-suit">${SUIT_MARKS[suit]}</span><span class="card-corner bottom"><b>${esc(rank)}</b><i>${SUIT_MARKS[suit]}</i></span></div>`;
}

function cardMarkup(card, index) {
  const suit = cardSuit(card);
  const rank = cardRank(card);
  const selected = state.selected.has(card);
  return `<button class="playing-card ${SUIT_CLASS[suit]} ${selected ? 'selected' : ''}" type="button" data-card="${esc(card)}" style="--i:${index}" aria-label="${rank} ${SUIT_NAMES[suit]}" aria-pressed="${selected}"><span class="card-corner top"><b>${esc(rank)}</b><i>${SUIT_MARKS[suit]}</i></span><span class="card-suit">${SUIT_MARKS[suit]}</span><span class="card-corner bottom"><b>${esc(rank)}</b><i>${SUIT_MARKS[suit]}</i></span></button>`;
}

function renderHand(room, isTurn) {
  const me = room.players.find((player) => player.id === state.playerId);
  const hand = [...(me?.hand || [])].sort(cardSort);
  $('handTitle').textContent = me ? `${hand.length} lá · ${me.name}` : 'Bạn chưa vào bàn';
  $('hand').innerHTML = hand.length ? hand.map(cardMarkup).join('') : '<div class="hand-empty">Bài của bạn sẽ xuất hiện sau khi chủ phòng chia bài.</div>';
  $('playButton').disabled = !isTurn || state.selected.size === 0 || room.gameOver;
  $('passButton').disabled = !isTurn || !room.currentPlay || room.gameOver;
  $('selectionHint').textContent = room.gameOver ? 'Ván đã kết thúc.' : isTurn ? (state.selected.size ? `${state.selected.size} lá đã chọn · sắp xếp theo luật miền Nam` : 'Chọn một hoặc nhiều lá để đánh.') : 'Đợi đến lượt bạn.';
}

avatarPicker.addEventListener('click', (event) => {
  const button = event.target.closest('[data-avatar]');
  if (!button) return;
  state.avatar = Number(button.dataset.avatar);
  localStorage.setItem('tienlen-avatar', String(state.avatar));
  renderAvatarPicker();
});
$('hand').addEventListener('click', (event) => {
  const button = event.target.closest('[data-card]');
  const room = state.room;
  if (!button || !room || room.turnPlayerId !== state.playerId || room.gameOver) return;
  const card = button.dataset.card;
  state.selected.has(card) ? state.selected.delete(card) : state.selected.add(card);
  renderHand(room, true);
});
roomList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-room-code]');
  if (!button || button.disabled) return;
  if (playerName.value.trim()) saveNickname(playerName.value);
  connect(button.dataset.roomCode, { push: true });
});
playerName.addEventListener('input', () => saveNickname(playerName.value));
topNick.addEventListener('input', () => saveNickname(topNick.value));
playerName.addEventListener('keydown', (event) => { if (event.key === 'Enter') roomList.querySelector('.room-choice:not(:disabled)')?.click(); });
topNick.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !gameLobbyView.classList.contains('hidden')) roomList.querySelector('.room-choice:not(:disabled)')?.click(); });
$('startButton').addEventListener('click', () => send({ type: 'start' }));
$('rematchButton').addEventListener('click', () => send({ type: 'restart' }));
$('playButton').addEventListener('click', () => {
  const cards = [...state.selected].sort(cardSort);
  send({ type: 'play', cards });
});
$('passButton').addEventListener('click', () => send({ type: 'pass' }));

$('leaveButton').addEventListener('click', () => {
  history.pushState({}, '', gamePath());
  showGameLobby();
});
$('soundButton').addEventListener('click', () => {
  state.sound = !state.sound;
  localStorage.setItem('tienlen-sound', state.sound ? 'on' : 'off');
  $('soundButton').textContent = state.sound ? '◖' : '◌';
});

renderAvatarPicker();
loadRooms();
setInterval(() => {
  if (!gameLobbyView.classList.contains('hidden')) loadRooms();
}, 5000);
document.querySelector('.brand').addEventListener('click', (event) => {
  event.preventDefault();
  history.pushState({}, '', '/');
  showHub();
});
window.addEventListener('popstate', () => applyRoute());
applyRoute(initialRoute);
