import { dealGame, passMove, playMove } from '../tienlen/public/engine.js';
import { settleCoins, STARTING_COINS, LOSS_PENALTY } from '../tienlen/public/economy.js';

const MAX_PLAYERS = 4;
const SESSION_DAYS = 30;

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
  return Object.fromEntries((request.headers.get('cookie') || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sessionCookie(request, token, maxAge = SESSION_DAYS * 86400) {
  return `game_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
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
    this.data.sessions[tokenHash] = { userId: user.id, expiresAt: Date.now() + SESSION_DAYS * 86400000 };
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
    const changes = [];
    let collected = 0;
    for (const loserId of loserIds) {
      const loser = this.data.users[loserId];
      const amount = -Math.min(LOSS_PENALTY, Math.max(0, loser.coins));
      loser.coins += amount;
      collected -= amount;
      changes.push({ userId: loserId, amount });
    }
    winner.coins += collected;
    changes.push({ userId: winnerId, amount: collected });
    const result = { ok: true, reference, penalty: LOSS_PENALTY, changes, balances: Object.fromEntries([...new Set([winnerId, ...loserIds])].map((id) => [id, this.data.users[id].coins])) };
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
    this.ready = state.storage.get('room').then((saved) => {
      this.room = saved || { phase: 'lobby', hostId: null, players: [], game: null, roomCode: null, roundId: null, settlement: null };
    });
  }

  async fetch(request) {
    await this.ready;
    this.room.roomCode = roomCode(new URL(request.url).pathname) || this.room.roomCode;
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
    const playerId = existing?.id || String(message.playerId || crypto.randomUUID()).slice(0, 64);
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
    if (this.room.players.length < 2) return this.error(session, 'Cần ít nhất 2 người để bắt đầu.');
    if (this.room.players.some((player) => player.coins < LOSS_PENALTY)) return this.error(session, `Mỗi người cần ít nhất ${LOSS_PENALTY} xu để bắt đầu.`);
    const players = this.room.players.map(({ id, accountId, username, name, avatar }) => ({ id, accountId, username, name, avatar }));
    this.room.game = dealGame(players);
    this.room.roundId = crypto.randomUUID();
    this.room.settlement = null;
    this.room.phase = 'game';
    await this.save();
    this.broadcastState();
  }

  async play(session, cards) {
    if (!this.isKnown(session) || this.room.phase !== 'game') return this.error(session, 'Chưa có ván đang chơi.');
    const result = playMove(this.room.game, session.playerId, cards);
    if (!result.ok) return this.error(session, result.error);
    this.room.game = result.game;
    if (result.game.gameOver && !this.room.settlement) await this.settleGame(result.game);
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
    if (this.room.players.some((player) => player.coins < LOSS_PENALTY)) return this.error(session, `Mỗi người cần ít nhất ${LOSS_PENALTY} xu để chơi tiếp.`);
    const players = this.room.players.map(({ id, accountId, username, name, avatar }) => ({ id, accountId, username, name, avatar }));
    this.room.game = dealGame(players);
    this.room.roundId = crypto.randomUUID();
    this.room.settlement = null;
    this.room.phase = 'game';
    await this.save();
    this.broadcastState();
  }

  async settleGame(game) {
    const winner = game.players.find((player) => player.id === game.winner);
    const loserIds = game.players.filter((player) => player.id !== game.winner).map((player) => player.accountId).filter(Boolean);
    if (!winner?.accountId || !loserIds.length) return;
    const id = this.env.ACCOUNTS.idFromName('global');
    const response = await this.env.ACCOUNTS.get(id).fetch(new Request('https://accounts/settle', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-account': '1' }, body: JSON.stringify({ reference: `${this.room.roomCode}:${this.room.roundId}`, winnerId: winner.accountId, loserIds }) }));
    if (!response.ok) return;
    const result = await response.json();
    const accountToPlayer = new Map(game.players.map((player) => [player.accountId, player.id]));
    this.room.settlement = { penalty: result.penalty, changes: result.changes.map((change) => ({ playerId: accountToPlayer.get(change.userId), amount: change.amount })) };
    for (const player of this.room.players) if (result.balances[player.accountId] !== undefined) player.coins = result.balances[player.accountId];
    for (const socket of this.sockets.values()) if (result.balances[socket.account.id] !== undefined) socket.account.coins = result.balances[socket.account.id];
  }

  onClose(session) {
    this.sockets.delete(session.socket);
    if (session.playerId) {
      const player = this.room?.players.find((item) => item.id === session.playerId);
      const stillConnected = [...this.sockets.values()].some((other) => other.playerId === session.playerId);
      if (player && !stillConnected) {
        player.connected = false;
        if (this.room.hostId === session.playerId) this.room.hostId = this.room.players.find((item) => item.connected)?.id || null;
        this.save().then(() => this.broadcastState());
      }
    }
  }

  isKnown(session) { return Boolean(session.playerId && this.room.players.some((player) => player.id === session.playerId)); }
  error(session, message) { this.send(session.socket, { type: 'error', message }); }

  viewFor(playerId, action) {
    const game = this.room.game;
    const players = this.room.players.map((member) => {
      const gamePlayer = game?.players.find((player) => player.id === member.id);
      return { id: member.id, username: member.username, name: member.name, avatar: member.avatar, connected: member.connected, handCount: gamePlayer?.hand.length ?? 0, hand: member.id === playerId ? (gamePlayer?.hand || []) : undefined };
    });
    const settlement = this.room.settlement ? { penalty: this.room.settlement.penalty, changes: this.room.settlement.changes } : null;
    return { type: 'state', you: playerId, phase: this.room.phase, roomCode: this.room.roomCode, hostId: this.room.hostId, players, turnPlayerId: game ? game.players[game.turnIndex]?.id : null, currentPlay: game?.currentPlay || null, gameOver: game?.gameOver || false, winner: game?.winner || null, wallet: this.sockets.get([...this.sockets.entries()].find(([, item]) => item.playerId === playerId)?.[0])?.account.coins ?? null, settlement, action: action || null };
  }

  broadcastState(action = null) { for (const session of this.sockets.values()) if (session.playerId) this.send(session.socket, this.viewFor(session.playerId, action)); }
  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { /* closed socket */ } }
  async save() { await this.state.storage.put('room', this.room); }
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
      const target = new URL(`https://accounts${path}`);
      target.searchParams.set('client_proto', url.protocol);
      const headers = new Headers(request.headers);
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global')).fetch(new Request(target, { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body }));
    }
    if (url.pathname === '/api/health') return json({ ok: true, service: 'game', game: 'tienlen' });
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
    return env.ASSETS.fetch(request);
  },
};
