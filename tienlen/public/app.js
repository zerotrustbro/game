import { cardRank, cardSort, cardSuit } from './engine.js';

const AVATARS = Array.from({ length: 8 }, (_, index) => `/assets/avatars/avatar-${String(index + 1).padStart(2, '0')}.png`);
const SUIT_NAMES = { s: 'bích', c: 'chuồn', d: 'rô', h: 'cơ' };
const SUIT_MARKS = { s: '♠', c: '♣', d: '♦', h: '♥' };
const SUIT_CLASS = { s: 'black', c: 'black', d: 'red', h: 'red' };
const state = {
  socket: null,
  roomCode: '',
  playerId: localStorage.getItem('tienlen-player-id') || crypto.randomUUID(),
  name: localStorage.getItem('tienlen-name') || '',
  avatar: Number(localStorage.getItem('tienlen-avatar') || 1),
  room: null,
  selected: new Set(),
  sound: localStorage.getItem('tienlen-sound') !== 'off',
};
localStorage.setItem('tienlen-player-id', state.playerId);

const $ = (id) => document.getElementById(id);
const homeView = $('homeView');
const roomView = $('roomView');
const playerName = $('playerName');
const roomInput = $('roomInput');
const avatarPicker = $('avatarPicker');
const toast = $('toast');
const connectionDot = $('connectionDot');
const connectionText = $('connectionText');

playerName.value = state.name;
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

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function connect(code) {
  state.roomCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!/^[A-Z0-9]{4,8}$/.test(state.roomCode)) return showToast('Mã phòng cần có 4–8 ký tự.', 'error');
  if (state.socket) state.socket.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/room/${state.roomCode}`);
  state.socket = socket;
  setConnection('Đang kết nối…');
  socket.addEventListener('open', () => {
    setConnection('Đã kết nối', true);
    socket.send(JSON.stringify({ type: 'join', playerId: state.playerId, name: state.name, avatar: state.avatar }));
  });
  socket.addEventListener('message', (event) => handleMessage(JSON.parse(event.data)));
  socket.addEventListener('close', () => {
    if (state.socket === socket) setConnection('Mất kết nối');
  });
  socket.addEventListener('error', () => showToast('Không thể kết nối phòng này.', 'error'));
}

function send(message) {
  if (state.socket?.readyState !== WebSocket.OPEN) return showToast('Kết nối chưa sẵn sàng.', 'error');
  state.socket.send(JSON.stringify(message));
}

function handleMessage(message) {
  if (message.type === 'connected') return;
  if (message.type === 'error') return showToast(message.message, 'error');
  if (message.type !== 'state') return;
  state.room = message;
  state.selected.clear();
  homeView.classList.add('hidden');
  roomView.classList.remove('hidden');
  $('roomCodeLabel').textContent = message.roomCode;
  renderRoom();
}

function renderAvatarPicker() {
  avatarPicker.innerHTML = AVATARS.map((src, index) => `<button class="avatar-choice ${state.avatar === index + 1 ? 'selected' : ''}" type="button" data-avatar="${index + 1}" aria-label="Chân dung ${index + 1}" aria-checked="${state.avatar === index + 1}"><img src="${src}" alt="" /></button>`).join('');
  avatarPicker.querySelectorAll('[data-avatar]').forEach((button) => button.addEventListener('click', () => {
    state.avatar = Number(button.dataset.avatar);
    localStorage.setItem('tienlen-avatar', String(state.avatar));
    renderAvatarPicker();
  }));
}

function seatMarkup(player, position, isLocal, isTurn) {
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
  $('seatTop').innerHTML = seatMarkup(top, 'top', false, top?.id === room.turnPlayerId);
  $('seatLeft').innerHTML = seatMarkup(left, 'left', false, left?.id === room.turnPlayerId);
  $('seatRight').innerHTML = seatMarkup(right, 'right', false, right?.id === room.turnPlayerId);
  $('seatBottom').innerHTML = seatMarkup(bottom, 'bottom', true, bottom?.id === room.turnPlayerId);
  $('lobbyPlayers').innerHTML = players.map((player) => `<span class="lobby-player ${player.connected ? '' : 'offline'}"><img src="${AVATARS[(player.avatar || 1) - 1]}" alt="" />${esc(player.name)}</span>`).join('');
  $('startButton').classList.toggle('hidden', room.phase !== 'lobby' || !isHost);
  $('rematchButton').classList.toggle('hidden', !room.gameOver || !isHost);
  $('roomTitle').textContent = room.gameOver ? `${room.winner === state.playerId ? 'Bạn thắng ván này' : 'Ván đã kết thúc'}` : room.phase === 'game' ? (isTurn ? 'Đến lượt bạn' : 'Đang trong ván') : 'Đang chờ người chơi';
  $('turnKicker').textContent = room.gameOver ? 'KẾT QUẢ' : room.phase === 'game' ? (isTurn ? 'LƯỢT CỦA BẠN' : `LƯỢT ${room.players.find((player) => player.id === room.turnPlayerId)?.name || ''}`) : 'PHÒNG CHỜ';
  renderCurrentPlay(room);
  $('tableStatus').textContent = room.gameOver ? (room.winner === state.playerId ? 'Chúc mừng — bạn là người hết bài trước.' : `${esc(room.players.find((player) => player.id === room.winner)?.name || 'Đối thủ')} đã thắng.`) : room.phase === 'game' ? (isTurn ? 'Chọn bài trên tay rồi đánh.' : 'Theo dõi lượt của đối thủ.') : (players.length < 2 ? 'Cần ít nhất 2 người để chia bài.' : (isHost ? 'Bạn có thể bắt đầu ván.' : 'Đợi chủ phòng bắt đầu ván.'));
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
  const playerName = esc(room.players.find((player) => player.id === current.playerId)?.name || 'Người chơi');
  const countClass = Math.min(current.cards.length, 8);
  $('lastPlay').innerHTML = `<div class="played-by"><b>${playerName}</b> vừa đánh</div><div class="played-cards count-${countClass}" aria-label="Bộ bài vừa đánh">${current.cards.map(tableCardMarkup).join('')}</div>`;
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
  $('handTitle').textContent = me ? `${hand.length} lá · ${esc(me.name)}` : 'Bạn chưa vào bàn';
  $('hand').innerHTML = hand.length ? hand.map(cardMarkup).join('') : '<div class="hand-empty">Bài của bạn sẽ xuất hiện sau khi chủ phòng chia bài.</div>';
  $('hand').querySelectorAll('[data-card]').forEach((button) => button.addEventListener('click', () => {
    if (!isTurn || room.gameOver) return;
    const card = button.dataset.card;
    state.selected.has(card) ? state.selected.delete(card) : state.selected.add(card);
    renderHand(room, isTurn);
  }));
  $('playButton').disabled = !isTurn || state.selected.size === 0 || room.gameOver;
  $('passButton').disabled = !isTurn || !room.currentPlay || room.gameOver;
  $('selectionHint').textContent = room.gameOver ? 'Ván đã kết thúc.' : isTurn ? (state.selected.size ? `${state.selected.size} lá đã chọn · sắp xếp theo luật miền Nam` : 'Chọn một hoặc nhiều lá để đánh.') : 'Đợi đến lượt bạn.';
}

$('createButton').addEventListener('click', () => {
  state.name = playerName.value.trim().slice(0, 18) || 'Người chơi';
  localStorage.setItem('tienlen-name', state.name);
  connect(makeRoomCode());
});
$('joinButton').addEventListener('click', () => {
  state.name = playerName.value.trim().slice(0, 18) || 'Người chơi';
  localStorage.setItem('tienlen-name', state.name);
  connect(roomInput.value.trim());
});
roomInput.addEventListener('input', () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
playerName.addEventListener('keydown', (event) => { if (event.key === 'Enter') $('createButton').click(); });
$('startButton').addEventListener('click', () => send({ type: 'start' }));
$('rematchButton').addEventListener('click', () => send({ type: 'restart' }));
$('playButton').addEventListener('click', () => {
  const cards = [...state.selected].sort(cardSort);
  send({ type: 'play', cards });
});
$('passButton').addEventListener('click', () => send({ type: 'pass' }));
$('copyRoomButton').addEventListener('click', async () => {
  await navigator.clipboard?.writeText(state.roomCode);
  showToast(`Đã sao chép mã phòng ${state.roomCode}.`);
});
$('leaveButton').addEventListener('click', () => {
  state.socket?.close();
  state.room = null;
  roomView.classList.add('hidden');
  homeView.classList.remove('hidden');
  setConnection('Chưa kết nối');
});
$('soundButton').addEventListener('click', () => {
  state.sound = !state.sound;
  localStorage.setItem('tienlen-sound', state.sound ? 'on' : 'off');
  $('soundButton').textContent = state.sound ? '◖' : '◌';
});

renderAvatarPicker();
setConnection('Chưa kết nối');
