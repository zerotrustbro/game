import { dealGame, passMove, playMove } from '../tienlen/public/engine.js';
import { settleCoins, STARTING_COINS, LOSS_PENALTY } from '../tienlen/public/economy.js';
import { ROOM_CODES } from '../tienlen/public/routes.js';
import { applyBattleDamage, applySpecial, applySpecialTurn, createBoard, initialRoom, MONSTERS, resolveSwap, SIZE } from '../poki/public/game.js';
import { POKI_ROOM_CODES } from '../poki/public/routes.js';

const MAX_PLAYERS = 4;
const POKI_MAX_PLAYERS = 2;
const POKI_MONSTER_IDS = Object.freeze(Object.keys(MONSTERS));
const POKI_GEMS = new Set(['sword', 'heart', 'mana']);
const SESSION_DAYS = 30;
const SECONDS_PER_DAY = 86400;
const SESSION_MAX_AGE = SESSION_DAYS * SECONDS_PER_DAY;
const SESSION_TTL = SESSION_MAX_AGE * 1000;
const PUBLIC_AUTH_PATHS = new Set(['/register', '/login', '/me', '/logout']);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function cleanName(value) {
  return String(value || 'Người chơi').trim().replace(/[<>]/g, '').slice(0, 18) || 'Người chơi';
}

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanAvatar(value) {
  const avatar = Number(value);
  return Number.isInteger(avatar) && avatar >= 1 && avatar <= 8 ? avatar : 1;
}

function roomCode(pathname) {
  const match = pathname.match(/^\/api\/room\/([A-Z0-9]{4,8})$/);
  return match?.[1] || null;
}

function pokiRoomCode(pathname) {
  const match = pathname.match(/^\/api\/poki\/room\/([A-Z0-9-]{1,12})$/);
  return match?.[1] || null;
}

const PLAYER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyRoom() {
  return { phase: 'lobby', hostId: null, players: [], game: null, roomCode: null, roundId: null, settlement: null };
}

function normalizeRoom(saved) {
  if (!saved || typeof saved !== 'object') return { room: emptyRoom(), changed: false };
  const room = { ...emptyRoom(), ...saved };
  let changed = false;
  const usedIds = new Set();
  const canonicalByOriginal = new Map();
  const savedPlayers = Array.isArray(saved.players) ? saved.players : [];
  const players = savedPlayers.map((player = {}) => {
    const originalId = player.id;
    let id = typeof originalId === 'string' && PLAYER_ID_PATTERN.test(originalId) && !usedIds.has(originalId) ? originalId : crypto.randomUUID();
    while (usedIds.has(id)) id = crypto.randomUUID();
    if (typeof originalId === 'string' && !canonicalByOriginal.has(originalId)) canonicalByOriginal.set(originalId, id);
    usedIds.add(id);
    if (id !== originalId) changed = true;
    return { ...player, id };
  });
  if (!Array.isArray(saved.players)) changed = true;
  room.players = players;

  const hostId = canonicalByOriginal.get(saved.hostId) || players[0]?.id || null;
  if (room.hostId !== hostId) changed = true;
  room.hostId = hostId;

  if (saved.game && typeof saved.game === 'object') {
    const game = { ...saved.game };
    const savedGamePlayers = Array.isArray(saved.game.players) ? saved.game.players : [];
    game.players = savedGamePlayers.map((player = {}, index) => {
      const member = player.accountId ? players.find((candidate) => candidate.accountId === player.accountId) : players[index];
      const id = member?.id || canonicalByOriginal.get(player.id) || player.id;
      if (id !== player.id) changed = true;
      return { ...player, id };
    });
    if (game.winner) {
      const winner = canonicalByOriginal.get(game.winner) || game.players.find((player) => player.id === game.winner)?.id || game.winner;
      if (winner !== game.winner) changed = true;
      game.winner = winner;
    }
    if (game.currentPlay?.playerId) {
      const playerId = canonicalByOriginal.get(game.currentPlay.playerId) || game.currentPlay.playerId;
      if (playerId !== game.currentPlay.playerId) changed = true;
      game.currentPlay = { ...game.currentPlay, playerId };
    }
    room.game = game;
  }

  return { room, changed };
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(bytes));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: decodeBase64(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return encodeBase64Url(new Uint8Array(bits));
}

function parseCookies(request) {
  const cookies = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookies instead of failing the whole request.
    }
  }
  return cookies;
}

function sessionCookie(request, token, maxAge = SESSION_MAX_AGE) {
  const url = new URL(request.url);
  const protocol = url.searchParams.get('client_proto') || url.protocol;
  const secure = protocol === 'https:' ? '; Secure' : '';
  return `game_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, coins: user.coins };
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export class AccountStore {
  constructor(state) {
    this.state = state;
    this.data = null;
    this.queue = Promise.resolve();
    this.ready = state.storage.get('accounts').then((saved) => {
      this.data = saved || { users: {}, usernames: {}, sessions: {}, ledger: {} };
    });
  }

  fetch(request) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await this.ready;
      return this.handle(request);
    });
    return this.queue;
  }

  async handle(request) {
    const path = new URL(request.url).pathname;
    if (path === '/register' && request.method === 'POST') return this.register(request);
    if (path === '/login' && request.method === 'POST') return this.login(request);
    if (path === '/me' && request.method === 'GET') return this.me(request);
    if (path === '/logout' && request.method === 'POST') return this.logout(request);
    if (path === '/resolve' && request.method === 'GET' && request.headers.get('x-internal-account') === '1') return this.resolve(request);
    if (path === '/settle' && request.method === 'POST' && request.headers.get('x-internal-account') === '1') return this.settle(request);
    return json({ error: 'Account route not found.' }, 404);
  }

  async register(request) {
    const body = await readJson(request);
    const username = cleanUsername(body?.username);
    const password = String(body?.password || '');
    const displayName = cleanName(body?.displayName || username);
    if (!/^[a-z0-9_]{3,18}$/.test(username)) return json({ error: 'Tên tài khoản cần 3–18 ký tự a-z, 0-9 hoặc _.' }, 400);
    if (password.length < 6 || password.length > 72) return json({ error: 'Mật khẩu cần 6–72 ký tự.' }, 400);
    if (this.data.usernames[username]) return json({ error: 'Tên tài khoản đã được sử dụng.' }, 409);
    const salt = encodeBase64(crypto.getRandomValues(new Uint8Array(16)));
    const user = { id: crypto.randomUUID(), username, displayName, salt, passwordHash: await passwordHash(password, salt), coins: STARTING_COINS, createdAt: Date.now() };
    this.data.users[user.id] = user;
    this.data.usernames[username] = user.id;
    await this.save();
    return this.issueSession(request, user, 201);
  }

  async login(request) {
    const body = await readJson(request);
    const username = cleanUsername(body?.username);
    const password = String(body?.password || '');
    const user = this.data.users[this.data.usernames[username]];
    if (!user || (await passwordHash(password, user.salt)) !== user.passwordHash) return json({ error: 'Tên tài khoản hoặc mật khẩu không đúng.' }, 401);
    return this.issueSession(request, user);
  }

  async issueSession(request, user, status = 200) {
    const token = randomToken();
    const tokenHash = await sha256(token);
    this.data.sessions[tokenHash] = { userId: user.id, expiresAt: Date.now() + SESSION_TTL };
    await this.save();
    return json({ user: publicUser(user) }, status, { 'set-cookie': sessionCookie(request, token) });
  }

  async resolveUser(request) {
    const token = parseCookies(request).game_session;
    if (!token) return null;
    const tokenHash = await sha256(token);
    const session = this.data.sessions[tokenHash];
    if (!session || session.expiresAt <= Date.now()) {
      if (session) { delete this.data.sessions[tokenHash]; await this.save(); }
      return null;
    }
    return this.data.users[session.userId] || null;
  }

  async me(request) {
    const user = await this.resolveUser(request);
    return user ? json({ user: publicUser(user) }) : json({ user: null }, 401);
  }

  async resolve(request) {
    const user = await this.resolveUser(request);
    return user ? json({ user: publicUser(user) }) : json({ user: null }, 401);
  }

  async logout(request) {
    const token = parseCookies(request).game_session;
    if (token) delete this.data.sessions[await sha256(token)];
    await this.save();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
  }

  async settle(request) {
    const body = await readJson(request);
    const reference = String(body?.reference || '');
    const winnerId = String(body?.winnerId || '');
    const loserIds = [...new Set((body?.loserIds || []).map(String).filter((id) => id && id !== winnerId))];
    if (!reference || !winnerId || !loserIds.length) return json({ error: 'Invalid settlement.' }, 400);
    if (this.data.ledger[reference]) return json(this.data.ledger[reference]);
    const winner = this.data.users[winnerId];
    if (!winner || loserIds.some((id) => !this.data.users[id])) return json({ error: 'Unknown account in settlement.' }, 400);
    const accountIds = [...new Set([winnerId, ...loserIds])];
    const balances = Object.fromEntries(accountIds.map((id) => [id, this.data.users[id].coins]));
    const settled = settleCoins(balances, winnerId, loserIds, LOSS_PENALTY);
    if (!settled.ok) return json({ error: 'Unable to settle accounts.' }, 500);
    for (const id of accountIds) this.data.users[id].coins = settled.balances[id];
    const result = { ok: true, reference, penalty: LOSS_PENALTY, changes: settled.changes, balances: settled.balances };
    this.data.ledger[reference] = result;
    await this.save();
    return json(result);
  }

  async save() {
    await this.state.storage.put('accounts', this.data);
  }
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.room = null;
    this.queue = Promise.resolve();
    this.ready = state.storage.get('room').then(async (saved) => {
      const normalized = normalizeRoom(saved);
      this.room = normalized.room;
      if (normalized.changed) await state.storage.put('room', this.room);
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/summary' && request.method === 'GET' && request.headers.get('x-internal-room') === '1') {
      return json(this.summary(url.searchParams.get('code') || this.room.roomCode, request.headers.get('x-account-id')));
    }
    this.room.roomCode = roomCode(url.pathname) || this.room.roomCode;
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const accountId = request.headers.get('x-account-id');
    if (!accountId) return json({ error: 'Bạn cần đăng nhập để chơi.' }, 401);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const session = { socket: server, playerId: null, account: { id: accountId, username: request.headers.get('x-account-username') || '', displayName: request.headers.get('x-account-display-name') || '', coins: Number(request.headers.get('x-account-coins') || 0) } };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
      this.queue = this.queue.catch(() => {}).then(() => this.onMessage(session, event.data));
    });
    server.addEventListener('close', () => this.onClose(session));
    server.addEventListener('error', () => this.onClose(session));
    server.send(JSON.stringify({ type: 'connected' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  summary(code, accountId) {
    const existing = accountId && this.room.players.some((player) => player.accountId === accountId);
    const players = this.room.players.length;
    return { code, players, maxPlayers: MAX_PLAYERS, phase: this.room.phase, canJoin: Boolean(existing) || (this.room.phase !== 'game' && players < MAX_PLAYERS) };
  }

  async onMessage(session, raw) {
    try {
      const message = JSON.parse(raw);
      switch (message.type) {
        case 'join': await this.join(session, message); break;
        case 'start': await this.start(session); break;
        case 'play': await this.play(session, message.cards); break;
        case 'pass': await this.pass(session); break;
        case 'restart': await this.restart(session); break;
        default: this.send(session.socket, { type: 'error', message: 'Yêu cầu không hợp lệ.' });
      }
    } catch {
      this.send(session.socket, { type: 'error', message: 'Không thể xử lý yêu cầu.' });
    }
  }

  async join(session, message) {
    const existing = this.room.players.find((player) => player.accountId === session.account.id);
    if (!existing && this.room.players.length >= MAX_PLAYERS) return this.send(session.socket, { type: 'error', message: 'Phòng đã đủ 4 người.' });
    if (this.room.phase === 'game' && !existing) return this.send(session.socket, { type: 'error', message: 'Ván đã bắt đầu, hãy vào ván kế tiếp.' });
    const playerId = existing?.id || crypto.randomUUID();
    if (existing) {
      existing.name = cleanName(session.account.displayName || message.name);
      existing.username = session.account.username;
      existing.accountId = session.account.id;
      existing.avatar = cleanAvatar(message.avatar || existing.avatar);
      existing.coins = session.account.coins;
      existing.connected = true;
    } else {
      this.room.players.push({ id: playerId, accountId: session.account.id, username: session.account.username, name: cleanName(session.account.displayName || message.name), avatar: cleanAvatar(message.avatar), coins: session.account.coins, connected: true });
      if (!this.room.hostId) this.room.hostId = playerId;
    }
    session.playerId = playerId;
    for (const other of this.sockets.values()) if (other !== session && other.playerId === playerId) other.playerId = null;
    await this.save();
    this.broadcastState();
  }

  async start(session) {
    if (!this.isKnown(session) || this.room.hostId !== session.playerId) return this.error(session, 'Chỉ chủ phòng mới có thể bắt đầu.');
    if (this.room.phase !== 'lobby') return this.error(session, 'Ván đang diễn ra.');
    if (this.room.players.length < 2) return this.error(session, 'Cần ít nhất 2 người để bắt đầu.');
    if (!this.canAffordRound()) return this.error(session, `Mỗi người cần ít nhất ${LOSS_PENALTY} xu để bắt đầu.`);
    await this.beginRound();
  }

  async play(session, cards) {
    if (!this.isKnown(session) || this.room.phase !== 'game') return this.error(session, 'Chưa có ván đang chơi.');
    const result = playMove(this.room.game, session.playerId, cards);
    if (!result.ok) return this.error(session, result.error);
    this.room.game = result.game;
    if (result.game.gameOver && this.room.settlement?.status !== 'complete') await this.settleGame(result.game);
    await this.save();
    this.broadcastState(result.action);
  }

  async pass(session) {
    if (!this.isKnown(session) || this.room.phase !== 'game') return this.error(session, 'Chưa có ván đang chơi.');
    const result = passMove(this.room.game, session.playerId);
    if (!result.ok) return this.error(session, result.error);
    this.room.game = result.game;
    await this.save();
    this.broadcastState(result.action);
  }

  async restart(session) {
    if (!this.isKnown(session) || this.room.hostId !== session.playerId) return this.error(session, 'Chỉ chủ phòng mới có thể chơi ván mới.');
    if (!this.room.game?.gameOver) return this.error(session, 'Ván hiện tại chưa kết thúc.');
    if (this.room.settlement?.status !== 'complete') {
      const settled = await this.settleGame(this.room.game);
      if (!settled) return this.error(session, 'Chưa thể hoàn tất thanh toán, hãy thử lại sau.');
    }
    if (!this.canAffordRound()) return this.error(session, `Mỗi người cần ít nhất ${LOSS_PENALTY} xu để chơi tiếp.`);
    await this.beginRound();
  }

  gamePlayers() {
    return this.room.players.map(({ id, accountId, username, name, avatar }) => ({ id, accountId, username, name, avatar }));
  }

  canAffordRound() {
    return !this.room.players.some((player) => player.coins < LOSS_PENALTY);
  }

  async beginRound() {
    this.room.game = dealGame(this.gamePlayers());
    this.room.roundId = crypto.randomUUID();
    this.room.settlement = null;
    this.room.phase = 'game';
    await this.save();
    this.broadcastState();
  }

  async settleGame(game) {
    const reference = `${this.room.roomCode}:${this.room.roundId}`;
    this.room.settlement = { status: 'pending', reference, penalty: LOSS_PENALTY, changes: [] };
    try {
      await this.save();
      const winner = game.players.find((player) => player.id === game.winner);
      const loserIds = game.players.filter((player) => player.id !== game.winner).map((player) => player.accountId).filter(Boolean);
      if (!winner?.accountId || !loserIds.length) throw new Error('Missing settlement account.');
      const id = this.env.ACCOUNTS.idFromName('global');
      const response = await this.env.ACCOUNTS.get(id).fetch(new Request('https://accounts/settle', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-account': '1' }, body: JSON.stringify({ reference, winnerId: winner.accountId, loserIds }) }));
      if (!response.ok) throw new Error(`Account settlement returned ${response.status}.`);
      const result = await response.json();
      const accountToPlayer = new Map(game.players.map((player) => [player.accountId, player.id]));
      this.room.settlement = { status: 'complete', reference, penalty: result.penalty, changes: result.changes.map((change) => ({ playerId: accountToPlayer.get(change.userId), amount: change.amount })) };
      for (const player of this.room.players) if (result.balances[player.accountId] !== undefined) player.coins = result.balances[player.accountId];
      for (const socket of this.sockets.values()) if (result.balances[socket.account.id] !== undefined) socket.account.coins = result.balances[socket.account.id];
      await this.save();
      return true;
    } catch (error) {
      this.room.settlement = { status: 'failed', reference, penalty: LOSS_PENALTY, changes: [] };
      console.error('Room settlement failed:', error);
      try {
        await this.save();
      } catch (saveError) {
        console.error('Room settlement failure state could not be saved:', saveError);
      }
      return false;
    }
  }

  onClose(session) {
    this.sockets.delete(session.socket);
    if (session.playerId) {
      const player = this.room?.players.find((item) => item.id === session.playerId);
      const stillConnected = [...this.sockets.values()].some((other) => other.playerId === session.playerId);
      if (player && !stillConnected) {
        player.connected = false;
        if (this.room.hostId === session.playerId) this.room.hostId = this.room.players.find((item) => item.connected)?.id || null;
        this.queue = this.queue
          .catch((error) => console.error('Room queue failed:', error))
          .then(async () => {
            await this.save();
            this.broadcastState();
          })
          .catch((error) => console.error('Room close persistence failed:', error));
      }
    }
  }

  isKnown(session) { return Boolean(session.playerId && this.room.players.some((player) => player.id === session.playerId)); }
  error(session, message) { this.send(session.socket, { type: 'error', message }); }

  viewFor(playerId, action) {
    const game = this.room.game;
    const gamePlayers = new Map(game?.players.map((player) => [player.id, player]));
    const players = this.room.players.map((member) => {
      const gamePlayer = gamePlayers.get(member.id);
      return { id: member.id, username: member.username, name: member.name, avatar: member.avatar, connected: member.connected, handCount: gamePlayer?.hand.length ?? 0, hand: member.id === playerId ? (gamePlayer?.hand || []) : undefined };
    });
    const settlement = this.room.settlement ? { status: this.room.settlement.status || 'complete', penalty: this.room.settlement.penalty, changes: this.room.settlement.changes } : null;
    const session = [...this.sockets.values()].find((item) => item.playerId === playerId);
    return { type: 'state', you: playerId, phase: this.room.phase, roomCode: this.room.roomCode, hostId: this.room.hostId, players, turnPlayerId: game ? game.players[game.turnIndex]?.id : null, currentPlay: game?.currentPlay || null, gameOver: game?.gameOver || false, winner: game?.winner || null, wallet: session?.account.coins ?? null, settlement, action: action || null };
  }

  broadcastState(action = null) { for (const session of this.sockets.values()) if (session.playerId) this.send(session.socket, this.viewFor(session.playerId, action)); }
  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { /* closed socket */ } }
  async save() { await this.state.storage.put('room', this.room); }
}

function freshPokiBattle(players) {
  const battle = initialRoom();
  for (const player of players) battle.players.push({ id: player.id, monster: player.monster, name: player.name, connected: player.connected });
  for (const player of battle.players) {
    battle.hp[player.id] = MONSTERS[player.monster].maxHp;
    battle.mana[player.id] = 0;
    battle.shield[player.id] = 0;
  }
  return battle;
}

function normalizePokiRoom(saved) {
  if (!saved || typeof saved !== 'object') return { room: initialRoom(), changed: false };
  const players = Array.isArray(saved.players)
    ? saved.players.slice(0, POKI_MAX_PLAYERS).map((player = {}) => ({
        id: String(player.id || crypto.randomUUID()).slice(0, 64),
        monster: POKI_MONSTER_IDS.includes(player.monster) ? player.monster : 'emberfox',
        name: cleanName(player.name),
        connected: player.connected !== false,
      }))
    : [];
  const boardOk = Array.isArray(saved.board) && saved.board.length === SIZE
    && saved.board.every((row) => Array.isArray(row) && row.length === SIZE && row.every((gem) => POKI_GEMS.has(gem)));
  const battle = { players, board: boardOk ? saved.board : createBoard(), hp: {}, mana: {}, shield: {}, turn: 0, gameOver: false, winner: undefined, loser: undefined, lastAction: undefined };
  for (const player of players) {
    const read = (record, fallback) => Number.isFinite(Number(saved[record]?.[player.id])) ? Number(saved[record][player.id]) : fallback;
    battle.hp[player.id] = Math.max(0, read('hp', MONSTERS[player.monster].maxHp));
    battle.mana[player.id] = Math.min(100, Math.max(0, read('mana', 0)));
    battle.shield[player.id] = Math.max(0, read('shield', 0));
  }
  battle.turn = Number.isInteger(saved.turn) && saved.turn >= 0 ? saved.turn : 0;
  battle.gameOver = Boolean(saved.gameOver) && players.length > 0;
  if (battle.gameOver && players.some((player) => player.id === saved.winner)) battle.winner = saved.winner;
  if (battle.gameOver && players.some((player) => player.id === saved.loser)) battle.loser = saved.loser;
  return { room: battle, changed: false };
}

export class PokiRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.code = null;
    this.battle = null;
    this.queue = Promise.resolve();
    this.ready = state.storage.get('poki').then((saved) => {
      this.battle = normalizePokiRoom(saved).room;
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const code = pokiRoomCode(url.pathname) || url.searchParams.get('code');
    if (code) this.code = code;
    if (url.pathname === '/summary' && request.method === 'GET' && request.headers.get('x-internal-room') === '1') {
      return json(this.summary(request.headers.get('x-account-id')));
    }
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const accountId = request.headers.get('x-account-id');
    if (!accountId) return json({ error: 'Bạn cần đăng nhập để chơi.' }, 401);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const session = {
      socket: server,
      account: {
        id: accountId,
        username: request.headers.get('x-account-username') || '',
        displayName: request.headers.get('x-account-display-name') || '',
      },
    };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
      this.queue = this.queue.catch(() => {}).then(() => this.onMessage(session, event.data));
    });
    server.addEventListener('close', () => this.onClose(session));
    server.addEventListener('error', () => this.onClose(session));
    return new Response(null, { status: 101, webSocket: client });
  }

  summary(accountId) {
    const players = this.battle.players.length;
    const existing = accountId ? this.battle.players.some((player) => player.id === accountId) : false;
    return {
      code: this.code || 'POKI??',
      players,
      maxPlayers: POKI_MAX_PLAYERS,
      phase: players >= POKI_MAX_PLAYERS ? 'game' : 'waiting',
      canJoin: existing || players < POKI_MAX_PLAYERS,
      gameOver: Boolean(this.battle.gameOver),
    };
  }

  async onMessage(session, raw) {
    try {
      const message = JSON.parse(raw);
      switch (message.type) {
        case 'join': await this.join(session, message); break;
        case 'move': await this.move(session, message); break;
        case 'special': await this.special(session); break;
        case 'restart': await this.restart(session); break;
        case 'leave': await this.leave(session); break;
        default: this.send(session.socket, { type: 'error', message: 'Yêu cầu không hợp lệ.' });
      }
    } catch {
      this.send(session.socket, { type: 'error', message: 'Không thể xử lý yêu cầu.' });
    }
  }

  socketFor(accountId) {
    return [...this.sockets.values()].find((session) => session.account.id === accountId) || null;
  }

  async join(session, message) {
    const monster = String(message.monster || '');
    if (!POKI_MONSTER_IDS.includes(monster)) return this.error(session, 'Hãy chọn một Poki thú.', true);
    const accountId = session.account.id;
    const existing = this.battle.players.find((player) => player.id === accountId);
    if (existing) {
      // Reconnect of an existing player: keep the battle in progress.
      existing.monster = monster;
      existing.name = cleanName(session.account.displayName || existing.name);
      existing.connected = true;
      await this.save();
      this.broadcastState();
      return;
    }
    if (this.battle.players.length >= POKI_MAX_PLAYERS) {
      const offline = this.battle.players.find((player) => player.connected === false);
      if (!offline) return this.error(session, 'Bàn đã đủ 2 người. Hãy chọn bàn khác.', true);
      this.battle.players.splice(this.battle.players.indexOf(offline), 1);
    }
    this.battle = addPokiPlayer(this.battle, accountId, monster, cleanName(session.account.displayName || 'Người chơi'));
    if (this.battle.players.length === POKI_MAX_PLAYERS) this.battle = freshPokiBattle(this.battle.players);
    await this.save();
    this.broadcastState();
  }

  async move(session, message) {
    if (this.battle.players.length !== POKI_MAX_PLAYERS) return this.error(session, 'Bàn chưa đủ hai người chơi.');
    const active = this.battle.players[this.battle.turn % POKI_MAX_PLAYERS];
    if (active?.id !== session.account.id) return this.error(session, 'Chưa đến lượt bạn.');
    if (this.battle.gameOver) return this.error(session, 'Trận đấu đã kết thúc. Hãy đấu lại hoặc rời bàn.');
    const { from, to } = message;
    if (!from || !to || !Number.isInteger(from.x) || !Number.isInteger(from.y) || !Number.isInteger(to.x) || !Number.isInteger(to.y)) return this.error(session, 'Nước đi không hợp lệ.');
    const result = resolveSwap(this.battle.board, from, to);
    if (!result.valid) return this.error(session, 'Đổi hai gem kề nhau để tạo bộ 3.');
    const self = this.battle.players.find((player) => player.id === session.account.id);
    const foe = this.battle.players.find((player) => player.id !== session.account.id);
    const hit = applyBattleDamage(this.battle, foe.id, result.damage);
    this.battle = {
      ...hit.state,
      board: result.board,
      hp: { ...hit.state.hp, [session.account.id]: Math.min(MONSTERS[self.monster].maxHp, this.battle.hp[session.account.id] + result.healing) },
      mana: { ...hit.state.mana, [session.account.id]: Math.min(100, this.battle.mana[session.account.id] + result.mana) },
      turn: this.battle.turn + 1,
      lastAction: { player: session.account.id, damage: result.damage, healing: result.healing, mana: result.mana, cleared: result.cleared, cascades: result.cascades, primaryKind: result.primaryKind, frames: result.frames },
    };
    await this.save();
    this.broadcastState();
  }

  async special(session) {
    if (this.battle.players.length !== POKI_MAX_PLAYERS) return this.error(session, 'Bàn chưa đủ hai người chơi.');
    const active = this.battle.players[this.battle.turn % POKI_MAX_PLAYERS];
    if (active?.id !== session.account.id) return this.error(session, 'Chưa đến lượt bạn.');
    if (this.battle.gameOver) return this.error(session, 'Trận đấu đã kết thúc. Hãy đấu lại hoặc rời bàn.');
    const player = this.battle.players.find((p) => p.id === session.account.id);
    const skill = applySpecial(player.monster, this.battle.mana[session.account.id]);
    if (!skill.valid) return this.error(session, 'Cần đủ 100 Mana để dùng kỹ năng.');
    const result = applySpecialTurn(this.battle, session.account.id, this.battle.mana[session.account.id], skill);
    this.battle = {
      ...result.state,
      turn: this.battle.turn + 1,
      lastAction: { player: session.account.id, damage: skill.damage, healing: skill.healing, mana: 0, cleared: 0, cascades: 0, special: true, skillName: skill.name },
    };
    await this.save();
    this.broadcastState();
  }

  async restart(session) {
    if (!this.battle.gameOver) return this.error(session, 'Trận hiện tại chưa kết thúc.');
    this.battle = freshPokiBattle(this.battle.players);
    await this.save();
    this.broadcastState();
  }

  async leave(session) {
    this.removePlayer(session.account.id);
    this.sockets.delete(session.socket);
    await this.save();
    this.broadcastState();
    try { session.socket.close(1000, 'bye'); } catch { /* closed */ }
  }

  removePlayer(accountId) {
    const index = this.battle.players.findIndex((player) => player.id === accountId);
    if (index < 0) return;
    this.battle.players.splice(index, 1);
    const remaining = this.battle.players.map(({ id, monster, name }) => ({ id, monster, name, connected: this.socketFor(id) != null }));
    this.battle = remaining.length ? freshPokiBattle(remaining) : initialRoom();
  }

  onClose(session) {
    this.sockets.delete(session.socket);
    const player = this.battle.players.find((item) => item.id === session.account.id);
    if (!player) return;
    const stillConnected = [...this.sockets.values()].some((other) => other.account.id === session.account.id);
    if (stillConnected) return;
    if (this.battle.gameOver || this.battle.players.length < POKI_MAX_PLAYERS) {
      this.queue = this.queue
        .catch((error) => console.error('Poki close queue failed:', error))
        .then(async () => {
          this.removePlayer(session.account.id);
          await this.save();
          this.broadcastState();
        })
        .catch((error) => console.error('Poki close persistence failed:', error));
    } else {
      player.connected = false;
      this.queue = this.queue
        .catch((error) => console.error('Poki close queue failed:', error))
        .then(async () => {
          await this.save();
          this.broadcastState();
        })
        .catch((error) => console.error('Poki close persistence failed:', error));
    }
  }

  viewFor(accountId) {
    return {
      type: 'state',
      you: accountId,
      roomCode: this.code,
      battle: {
        players: this.battle.players.map((player) => ({ id: player.id, monster: player.monster, name: player.name, connected: player.connected })),
        board: this.battle.board,
        hp: this.battle.hp,
        mana: this.battle.mana,
        shield: this.battle.shield,
        turn: this.battle.turn,
        lastAction: this.battle.lastAction,
        gameOver: this.battle.gameOver,
        winner: this.battle.winner,
        loser: this.battle.loser,
      },
    };
  }

  broadcastState() { for (const session of this.sockets.values()) this.send(session.socket, this.viewFor(session.account.id)); }
  error(session, message, fatal = false) { this.send(session.socket, { type: 'error', message, ...(fatal ? { fatal: true } : {}) }); }
  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { /* closed socket */ } }
  async save() { await this.state.storage.put('poki', this.battle); }
}

function addPokiPlayer(battle, accountId, monster, name) {
  const state = { ...battle, players: [...battle.players] };
  state.players.push({ id: accountId, monster, name, connected: true });
  state.hp = { ...state.hp, [accountId]: MONSTERS[monster].maxHp };
  state.mana = { ...state.mana, [accountId]: 0 };
  state.shield = { ...state.shield, [accountId]: 0 };
  return state;
}

async function roomSummary(env, code, accountId) {
  const headers = new Headers({ 'x-internal-room': '1' });
  if (accountId) headers.set('x-account-id', accountId);
  try {
    const response = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(`https://room/summary?code=${code}`, { headers }));
    if (response.ok) return response.json();
  } catch {
    // Report an unavailable table as non-joinable instead of exposing a broken entry.
  }
  return { code, players: 0, maxPlayers: MAX_PLAYERS, phase: 'unavailable', canJoin: false };
}

async function pokiRoomSummary(env, code, accountId) {
  const headers = new Headers({ 'x-internal-room': '1' });
  if (accountId) headers.set('x-account-id', accountId);
  try {
    const response = await env.POKI_ROOMS.get(env.POKI_ROOMS.idFromName(code)).fetch(new Request(`https://pokiroom/summary?code=${code}`, { headers }));
    if (response.ok) return response.json();
  } catch {
    // Report an unavailable table as non-joinable instead of exposing a broken entry.
  }
  return { code, players: 0, maxPlayers: POKI_MAX_PLAYERS, phase: 'unavailable', canJoin: false, gameOver: false };
}

async function accountForRequest(request, env) {
  const id = env.ACCOUNTS.idFromName('global');
  const response = await env.ACCOUNTS.get(id).fetch(new Request('https://accounts/resolve', { headers: { cookie: request.headers.get('cookie') || '', 'x-internal-account': '1' } }));
  if (!response.ok) return null;
  return (await response.json()).user;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/auth/')) {
      const path = url.pathname.replace('/api/auth', '') || '/me';
      if (!PUBLIC_AUTH_PATHS.has(path)) return json({ error: 'Account route not found.' }, 404);
      const target = new URL(`https://accounts${path}`);
      target.searchParams.set('client_proto', url.protocol);
      const headers = new Headers(request.headers);
      headers.delete('x-internal-account');
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global')).fetch(new Request(target, { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body }));
    }
    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      const account = request.headers.get('cookie') ? await accountForRequest(request, env) : null;
      const rooms = await Promise.all(ROOM_CODES.map((code) => roomSummary(env, code, account?.id || null)));
      return json({ rooms });
    }
    if (url.pathname === '/api/poki/rooms' && request.method === 'GET') {
      const account = request.headers.get('cookie') ? await accountForRequest(request, env) : null;
      const rooms = await Promise.all(POKI_ROOM_CODES.map((code) => pokiRoomSummary(env, code, account?.id || null)));
      return json({ rooms });
    }
    if (url.pathname === '/api/health') return json({ ok: true, service: 'game', game: 'tienlen' });
    const pokiCode = pokiRoomCode(url.pathname);
    if (pokiCode) {
      if (!POKI_ROOM_CODES.includes(pokiCode.toUpperCase())) return json({ error: 'Không tìm thấy bàn này.' }, 404);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      const account = await accountForRequest(request, env);
      if (!account) return json({ error: 'Bạn cần đăng nhập để chơi.' }, 401);
      const headers = new Headers(request.headers);
      headers.set('x-account-id', account.id);
      headers.set('x-account-username', account.username);
      headers.set('x-account-display-name', account.displayName);
      headers.set('x-account-coins', String(account.coins));
      return env.POKI_ROOMS.get(env.POKI_ROOMS.idFromName(pokiCode.toUpperCase())).fetch(new Request(request, { headers }));
    }
    const code = roomCode(url.pathname);
    if (code) {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      const account = await accountForRequest(request, env);
      if (!account) return json({ error: 'Bạn cần đăng nhập để chơi.' }, 401);
      const headers = new Headers(request.headers);
      headers.set('x-account-id', account.id);
      headers.set('x-account-username', account.username);
      headers.set('x-account-display-name', account.displayName);
      headers.set('x-account-coins', String(account.coins));
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request, { headers }));
    }
    if (url.pathname === '/poki' || url.pathname === '/poki/') {
      return env.ASSETS.fetch(new Request(new URL('/poki/index.html', url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
