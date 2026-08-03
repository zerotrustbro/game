import { cardRank, cardSort, cardSuit } from './engine.js';
import { gamePath, parseRoute, roomPath } from './routes.js';

const AVATARS = Array.from({ length: 8 }, (_, index) => `/assets/avatars/avatar-${String(index + 1).padStart(2, '0')}.webp`);
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
  user: null,
  selected: new Set(),
  sound: localStorage.getItem('tienlen-sound') !== 'off',
};
localStorage.setItem('tienlen-player-id', state.playerId);

const $ = (id) => document.getElementById(id);
const hubView = $('hubView');
const gameLobbyView = $('gameLobbyView');
const roomView = $('roomView');
const playerName = $('playerName');
const roomInput = $('roomInput');
const avatarPicker = $('avatarPicker');
const toast = $('toast');
const connectionDot = $('connectionDot');
const connectionText = $('connectionText');
const initialRoute = parseRoute(location.pathname);
const authPanel = $('authPanel');
const authBackdrop = $('authBackdrop');
let pendingRoomCode = null;

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

function updateAccountUi() {
  $('accountButton').textContent = state.user ? `${state.user.displayName} · ${state.user.coins} xu` : 'Tài khoản';
  $('accountSummary').classList.toggle('hidden', !state.user);
  $('loginForm').classList.toggle('hidden', Boolean(state.user));
  $('registerForm').classList.toggle('hidden', Boolean(state.user));
  $('loginTab').classList.toggle('hidden', Boolean(state.user));
  $('registerTab').classList.toggle('hidden', Boolean(state.user));
  $('authTitle').textContent = state.user ? 'Tài khoản của bạn' : 'Đăng nhập để chơi';
  $('accountName').textContent = state.user?.displayName || '—';
  $('accountCoins').textContent = state.user?.coins ?? 0;
}

function openAuth() {
  $('authError').textContent = '';
  authPanel.classList.remove('hidden');
  authBackdrop.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeAuth() {
  authPanel.classList.add('hidden');
  authBackdrop.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

async function authRequest(path, body) {
  const response = await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Không thể xử lý tài khoản.');
  return data.user;
}

async function loadAccount() {
  try {
    const response = await fetch('/api/auth/me');
    if (response.ok) state.user = (await response.json()).user;
  } catch {
    // An unavailable auth endpoint should leave the visitor in guest mode.
  }
  updateAccountUi();
  if (state.user && pendingRoomCode) {
    const code = pendingRoomCode;
    pendingRoomCode = null;
    closeAuth();
    connect(code);
  }
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randomBytes = new Uint8Array(6);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (value) => chars[value % chars.length]).join('');
}

function connect(code, { push = false } = {}) {
  state.roomCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!/^[A-Z0-9]{4,8}$/.test(state.roomCode)) return showToast('Mã phòng cần có 4–8 ký tự.', 'error');
  if (!state.user) {
    pendingRoomCode = state.roomCode;
    showGameLobby(state.roomCode);
    openAuth();
    return;
  }
  history[push ? 'pushState' : 'replaceState']({}, '', roomPath(state.roomCode));
  if (state.socket) state.socket.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/room/${state.roomCode}`);
  state.socket = socket;
  setConnection('Đang kết nối…');
  socket.addEventListener('open', () => {
    setConnection('Đã kết nối', true);
    socket.send(JSON.stringify({ type: 'join', playerId: state.playerId, name: state.name, avatar: state.avatar }));
  });
  socket.addEventListener('message', (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch {
      showToast('Phản hồi từ phòng không hợp lệ.', 'error');
    }
  });
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
  hubView.classList.add('hidden');
  gameLobbyView.classList.add('hidden');
  roomView.classList.remove('hidden');
  $('roomCodeLabel').textContent = message.roomCode;
  renderRoom();
}

function showHub() {
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
  inviteNote.textContent = roomCode ? `Bạn được mời vào phòng ${roomCode}. Nhập tên rồi vào bàn.` : '';
  if (roomCode) roomInput.value = roomCode;
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
  if (room.wallet !== null && state.user) {
    state.user.coins = room.wallet;
    updateAccountUi();
  }
  $('turnKicker').textContent = room.gameOver ? 'KẾT QUẢ' : room.phase === 'game' ? (isTurn ? 'LƯỢT CỦA BẠN' : `LƯỢT ${room.players.find((player) => player.id === room.turnPlayerId)?.name || ''}`) : 'PHÒNG CHỜ';
  renderCurrentPlay(room);
  const settlement = room.settlement?.changes?.find((change) => change.playerId === room.you);
  $('tableStatus').textContent = room.gameOver ? `${room.winner === room.you ? 'Chúc mừng — bạn là người hết bài trước.' : `${esc(room.players.find((player) => player.id === room.winner)?.name || 'Đối thủ')} đã thắng.`} ${settlement ? `${settlement.amount >= 0 ? '+' : ''}${settlement.amount} xu.` : ''}` : room.phase === 'game' ? (isTurn ? 'Chọn bài trên tay rồi đánh.' : 'Theo dõi lượt của đối thủ.') : (players.length < 2 ? 'Cần ít nhất 2 người để bắt đầu.' : (isHost ? 'Bạn có thể bắt đầu ván.' : 'Đợi chủ phòng bắt đầu ván.'));
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
  $('handTitle').textContent = me ? `${hand.length} lá · ${me.name}` : 'Bạn chưa vào bàn';
  $('hand').innerHTML = hand.length ? hand.map(cardMarkup).join('') : '<div class="hand-empty">Bài của bạn sẽ xuất hiện sau khi chủ phòng chia bài.</div>';
  $('playButton').disabled = !isTurn || state.selected.size === 0 || room.gameOver;
  $('passButton').disabled = !isTurn || !room.currentPlay || room.gameOver;
  $('selectionHint').textContent = room.gameOver ? 'Ván đã kết thúc.' : isTurn ? (state.selected.size ? `${state.selected.size} lá đã chọn · sắp xếp theo luật miền Nam` : 'Chọn một hoặc nhiều lá để đánh.') : 'Đợi đến lượt bạn.';
}

$('createButton').addEventListener('click', () => {
  state.name = playerName.value.trim().slice(0, 18) || 'Người chơi';
  localStorage.setItem('tienlen-name', state.name);
  connect(makeRoomCode(), { push: true });
});
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
$('joinButton').addEventListener('click', () => {
  state.name = playerName.value.trim().slice(0, 18) || 'Người chơi';
  localStorage.setItem('tienlen-name', state.name);
  connect(roomInput.value.trim(), { push: true });
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
  const link = `${location.origin}${roomPath(state.roomCode)}`;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(link);
    showToast('Đã sao chép link mời bạn vào phòng.');
  } catch {
    showToast('Không thể sao chép link trên thiết bị này.', 'error');
  }
});
$('leaveButton').addEventListener('click', () => {
  history.pushState({}, '', gamePath());
  showGameLobby();
});
$('soundButton').addEventListener('click', () => {
  state.sound = !state.sound;
  localStorage.setItem('tienlen-sound', state.sound ? 'on' : 'off');
  $('soundButton').textContent = state.sound ? '◖' : '◌';
});

$('accountButton').addEventListener('click', openAuth);
$('authClose').addEventListener('click', closeAuth);
authBackdrop.addEventListener('click', closeAuth);
$('loginTab').addEventListener('click', () => {
  $('loginTab').classList.add('active'); $('registerTab').classList.remove('active');
  $('loginForm').classList.remove('hidden'); $('registerForm').classList.add('hidden'); $('authTitle').textContent = 'Đăng nhập để chơi';
});
$('registerTab').addEventListener('click', () => {
  $('registerTab').classList.add('active'); $('loginTab').classList.remove('active');
  $('registerForm').classList.remove('hidden'); $('loginForm').classList.add('hidden'); $('authTitle').textContent = 'Tạo tài khoản';
});
async function finishAuth(user) {
  state.user = user;
  state.name = user.displayName;
  localStorage.setItem('tienlen-name', state.name);
  updateAccountUi();
  closeAuth();
  if (pendingRoomCode) { const code = pendingRoomCode; pendingRoomCode = null; connect(code); }
}
$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await finishAuth(await authRequest('/login', { username: $('loginUsername').value, password: $('loginPassword').value })); }
  catch (error) { $('authError').textContent = error.message; }
});
$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await finishAuth(await authRequest('/register', { username: $('registerUsername').value, displayName: $('registerDisplayName').value, password: $('registerPassword').value })); }
  catch (error) { $('authError').textContent = error.message; }
});
$('logoutButton').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  state.user = null;
  state.socket?.close();
  state.socket = null;
  updateAccountUi();
  closeAuth();
  showHub();
});

renderAvatarPicker();
loadAccount();
document.querySelector('.brand').addEventListener('click', (event) => {
  event.preventDefault();
  history.pushState({}, '', '/');
  showHub();
});
window.addEventListener('popstate', () => applyRoute());
applyRoute(initialRoute);
