import { dealGame, passMove, playMove, skipLead } from '../tienlen/public/engine.js';
import { ROOM_CODES } from '../tienlen/public/routes.js';
import { applyBattleDamage, applySpecial, applySpecialTurn, createBoard, initialRoom, MONSTERS, resolveSwap, SIZE } from '../poki/public/game.js';
import { POKI_ROOM_CODES } from '../poki/public/routes.js';
import { addPlayer as xoAddPlayer, evaluateBoard as xoEvaluateBoard, initialGame, makeMove as xoMove } from '../xo/public/game.js';
import { XO_ROOM_CODES } from '../xo/public/routes.js';

const MAX_PLAYERS = 4;
const POKI_MAX_PLAYERS = 2;
const XO_MAX_PLAYERS = 2;
const POKI_MONSTER_IDS = Object.freeze(Object.keys(MONSTERS));
const POKI_GEMS = new Set(['sword', 'heart', 'mana']);
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
// Upper bound for a single WebSocket frame: room messages are tiny JSON
// (cards, cells, moves), so anything bigger is hostile or broken.
const MAX_MESSAGE_SIZE = 64 * 1024;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function cleanName(value) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, 18) || 'Người chơi';
}

function cleanId(value) {
  const id = String(value || '').trim();
  return ID_PATTERN.test(id) ? id : crypto.randomUUID();
}

function cleanAvatar(value) {
  const avatar = Number(value);
  return Number.isInteger(avatar) && avatar >= 1 && avatar <= 8 ? avatar : 1;
}

function roomCode(pathname) {
  const match = pathname.match(/^\/api\/room\/([A-Za-z0-9]{4,8})$/);
  return match?.[1]?.toUpperCase() || null;
}

function pokiRoomCode(pathname) {
  const match = pathname.match(/^\/api\/poki\/room\/([A-Za-z0-9-]{1,12})$/);
  return match?.[1]?.toUpperCase() || null;
}

function xoRoomCode(pathname) {
  const match = pathname.match(/^\/api\/xo\/room\/([A-Za-z0-9]{4,8})$/);
  return match?.[1]?.toUpperCase() || null;
}

function emptyRoom() {
  return { phase: 'lobby', hostId: null, players: [], game: null, roomCode: null };
}

function normalizeRoom(saved) {
  if (!saved || typeof saved !== 'object') return { room: emptyRoom(), changed: false };
  const room = { ...emptyRoom(), ...saved };
  let changed = false;
  for (const key of ['accountId', 'coins', 'xu', 'settlement']) {
    if (key in room) {
      delete room[key];
      changed = true;
    }
  }
  if (!['lobby', 'game'].includes(room.phase)) {
    room.phase = 'lobby';
    room.game = null;
    changed = true;
  }
  const usedIds = new Set();
  const canonicalByOriginal = new Map();
  const savedPlayers = Array.isArray(saved.players) ? saved.players.slice(0, MAX_PLAYERS) : [];
  const players = savedPlayers.map((rawPlayer = {}) => {
    const player = rawPlayer && typeof rawPlayer === 'object' ? rawPlayer : {};
    const originalId = player.id;
    let id = typeof originalId === 'string' && ID_PATTERN.test(originalId) && !usedIds.has(originalId) ? originalId : crypto.randomUUID();
    while (usedIds.has(id)) id = crypto.randomUUID();
    if (typeof originalId === 'string' && !canonicalByOriginal.has(originalId)) canonicalByOriginal.set(originalId, id);
    usedIds.add(id);
    if (id !== originalId || 'accountId' in player || 'coins' in player || 'username' in player) changed = true;
    return { id, name: cleanName(player.name), avatar: cleanAvatar(player.avatar), connected: player.connected !== false };
  });
  if (!Array.isArray(saved.players)) changed = true;
  if (Array.isArray(saved.players) && saved.players.length !== players.length) changed = true;
  room.players = players;

  const requestedHost = canonicalByOriginal.get(saved.hostId) || saved.hostId;
  const hostId = players.some((player) => player.id === requestedHost && player.connected)
    ? requestedHost
    : players.find((player) => player.connected)?.id || players[0]?.id || null;
  if (room.hostId !== hostId) changed = true;
  room.hostId = hostId;

  if (saved.game && typeof saved.game === 'object') {
    const game = { ...saved.game };
    for (const key of ['accountId', 'coins', 'xu', 'settlement']) {
      if (key in game) {
        delete game[key];
        changed = true;
      }
    }
    const savedGamePlayers = Array.isArray(saved.game.players) ? saved.game.players : [];
    game.players = savedGamePlayers.map((rawPlayer = {}, index) => {
      const player = rawPlayer && typeof rawPlayer === 'object' ? rawPlayer : {};
      const member = player.accountId ? players.find((candidate) => candidate.id === player.accountId) : players[index];
      const id = member?.id || canonicalByOriginal.get(player.id) || player.id;
      const normalizedPlayer = {
        id,
        name: cleanName(player.name),
        avatar: cleanAvatar(player.avatar),
        hand: Array.isArray(player.hand) ? [...player.hand] : [],
      };
      if (id !== player.id || normalizedPlayer.name !== player.name || normalizedPlayer.avatar !== player.avatar || !Array.isArray(player.hand) || Object.keys(player).some((key) => !['id', 'name', 'avatar', 'hand'].includes(key))) changed = true;
      return normalizedPlayer;
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
  if (room.phase === 'game' && room.game && (!Array.isArray(room.game.players) || room.game.players.length < 2)) {
    room.phase = 'lobby';
    room.game = null;
    changed = true;
  } else if (room.phase === 'lobby' && room.game) {
    room.game = null;
    room.roundId = null;
    changed = true;
  }

  return { room, changed };
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
      let changed = normalized.changed;
      if (this.room.players.length) {
        // DO rehydration: no WebSocket survives an eviction/restart, so every
        // persisted seat is a ghost. Mark them offline so the seats (and the
        // host role) can be reclaimed, and reopen a mid-game table as a lobby.
        for (const player of this.room.players) if (player.connected) { player.connected = false; changed = true; }
        if (this.room.phase === 'game') { this.room.phase = 'lobby'; this.room.game = null; changed = true; }
        // Keep the host role when the host's seat survived; free it otherwise.
        if (this.room.hostId && !this.room.players.some((player) => player.id === this.room.hostId)) { this.room.hostId = null; changed = true; }
      }
      if (changed) await state.storage.put('room', this.room);
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/summary' && request.method === 'GET' && request.headers.get('x-internal-room') === '1') {
      return json(this.summary(url.searchParams.get('code') || this.room.roomCode, url.searchParams.get('pid') || ''));
    }
    this.room.roomCode = roomCode(url.pathname) || this.room.roomCode;
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const session = { socket: server, playerId: null, closed: false };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_SIZE) { this.error(session, 'Yêu cầu quá lớn.', true); return; }
      this.queue = this.queue.catch(() => {}).then(() => this.onMessage(session, event.data));
    });
    server.addEventListener('close', () => this.onClose(session));
    server.addEventListener('error', () => this.onClose(session));
    server.send(JSON.stringify({ type: 'connected' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  summary(code, playerId) {
    const existing = playerId ? this.room.players.some((player) => player.id === playerId) : false;
    const players = this.room.players.length;
    return { code, players, maxPlayers: MAX_PLAYERS, phase: this.room.phase, canJoin: Boolean(existing) || (this.room.phase !== 'game' && players < MAX_PLAYERS) || this.room.players.some((player) => player.connected === false) };
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
        case 'leave': await this.leave(session); break;
        default: this.send(session.socket, { type: 'error', message: 'Yêu cầu không hợp lệ.' });
      }
    } catch {
      this.send(session.socket, { type: 'error', message: 'Không thể xử lý yêu cầu.' });
    }
  }

  async join(session, message) {
    const id = cleanId(message.id);
    if (session.playerId && session.playerId !== id) return this.error(session, 'Kết nối này đã gắn với người chơi khác.', true);
    const existing = this.room.players.find((player) => player.id === id);
    if (this.room.phase === 'game' && !existing) return this.error(session, 'Ván đã bắt đầu, hãy vào ván kế tiếp.', true);
    if (!existing && this.room.players.length >= MAX_PLAYERS) {
      const offline = this.room.players.find((player) => player.connected === false);
      if (!offline) return this.error(session, 'Phòng đã đủ 4 người.', true);
      this.room.players.splice(this.room.players.indexOf(offline), 1);
      if (this.room.hostId === offline.id) this.room.hostId = null;
    }
    const playerId = existing?.id || id;
    // A host whose seat is gone or offline loses the role to the next joiner,
    // so a ghost host can never block a live table.
    const hostSeat = this.room.players.find((player) => player.id === this.room.hostId);
    if (this.room.hostId && (!hostSeat || hostSeat.connected === false)) this.room.hostId = null;
    if (existing) {
      existing.name = cleanName(message.name);
      existing.avatar = cleanAvatar(message.avatar || existing.avatar);
      existing.connected = true;
    } else {
      this.room.players.push({ id: playerId, name: cleanName(message.name), avatar: cleanAvatar(message.avatar), connected: true });
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
    const connectedPlayers = this.room.players.filter((player) => player.connected);
    if (connectedPlayers.length < 2) return this.error(session, 'Cần ít nhất 2 người đang kết nối để bắt đầu.');
    if (connectedPlayers.length !== this.room.players.length) {
      this.room.players = connectedPlayers;
      this.room.hostId = connectedPlayers[0].id;
    }
    await this.beginRound();
  }

  async play(session, cards) {
    if (!this.isKnown(session) || this.room.phase !== 'game') return this.error(session, 'Chưa có ván đang chơi.');
    let result = playMove(this.room.game, session.playerId, cards);
    if (!result.ok && this.advancePastOffline()) {
      // The turn holder disconnected mid-game: skip their turn, then validate
      // the request against the advanced table. The skip is only committed
      // together with a valid move, so a bad request never moves the game.
      result = playMove(this.room.game, session.playerId, cards);
    }
    if (!result.ok) return this.error(session, result.error);
    this.room.game = result.game;
    await this.save();
    this.broadcastState(result.action);
  }

  async pass(session) {
    if (!this.isKnown(session) || this.room.phase !== 'game') return this.error(session, 'Chưa có ván đang chơi.');
    let result = passMove(this.room.game, session.playerId);
    if (!result.ok && this.advancePastOffline()) {
      result = passMove(this.room.game, session.playerId);
    }
    if (!result.ok) return this.error(session, result.error);
    this.room.game = result.game;
    await this.save();
    this.broadcastState(result.action);
  }

  async restart(session) {
    if (!this.isKnown(session) || this.room.hostId !== session.playerId) return this.error(session, 'Chỉ chủ phòng mới có thể chơi ván mới.');
    if (!this.room.game?.gameOver) return this.error(session, 'Ván hiện tại chưa kết thúc.');
    // A rematch never includes seats whose owners disconnected mid-match.
    if (this.room.players.some((player) => !player.connected)) {
      this.room.players = this.room.players.filter((player) => player.connected);
      if (!this.room.players.some((player) => player.id === this.room.hostId)) this.room.hostId = this.room.players[0]?.id || null;
    }
    if (this.room.players.length < 2) return this.error(session, 'Cần ít nhất 2 người đang kết nối để chơi ván mới.');
    await this.beginRound();
  }

  async leave(session) {
    if (this.isKnown(session)) this.removePlayer(session.playerId);
    session.playerId = null;
    this.sockets.delete(session.socket);
    await this.save();
    this.broadcastState();
    try { session.socket.close(1000, 'bye'); } catch { /* closed */ }
  }

  gamePlayers() {
    return this.room.players.map(({ id, name, avatar }) => ({ id, name, avatar }));
  }

  async beginRound() {
    this.room.game = dealGame(this.gamePlayers());
    this.room.phase = 'game';
    await this.save();
    this.broadcastState();
  }

  onClose(session) {
    if (session.closed) return;
    session.closed = true;
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
            // A lobby seat or a finished match is no longer a reconnect window.
            // Remove that player so the table can accept a fresh challenger.
            if (this.room.phase !== 'game' || this.room.game?.gameOver) {
              this.removePlayer(session.playerId);
            } else if (!this.room.players.some((item) => item.connected)) {
              // Everyone left: reset the table so newcomers can play.
              const code = this.room.roomCode;
              this.room = emptyRoom();
              this.room.roomCode = code;
            } else {
              // Someone is still here: keep the game moving past disconnected players.
              this.advancePastOffline();
            }
            await this.save();
            this.broadcastState();
          })
          .catch((error) => console.error('Room close persistence failed:', error));
      }
    }
  }

  removePlayer(playerId) {
    const code = this.room.roomCode;
    const players = this.room.players.filter((player) => player.id !== playerId);
    if (!players.some((player) => player.connected)) {
      this.room = emptyRoom();
      this.room.roomCode = code;
      return;
    }
    this.room = emptyRoom();
    this.room.roomCode = code;
    this.room.players = players;
    this.room.hostId = players.find((player) => player.connected)?.id || null;
  }

  isKnown(session) { return Boolean(session.playerId && this.room.players.some((player) => player.id === session.playerId)); }
  error(session, message, fatal = false) { this.send(session.socket, { type: 'error', message, ...(fatal ? { fatal: true } : {}) }); }

  // Skip the turns of players who disconnected mid-game so a table never stalls.
  // A disconnected player who would just pass is passed automatically; one who
  // must lead simply yields the lead to the next player.
  advancePastOffline() {
    const game = this.room.game;
    if (this.room.phase !== 'game' || !game || game.gameOver) return false;
    if (!this.room.players.some((player) => player.connected)) return false; // everyone offline → reset branch handles it
    let changed = false;
    let guard = 0;
    while (guard++ < this.room.players.length) {
      const current = this.room.game;
      const turnPlayer = current.players[current.turnIndex];
      const seat = turnPlayer && this.room.players.find((player) => player.id === turnPlayer.id);
      if (!turnPlayer || !seat || seat.connected) break;
      if (current.currentPlay) {
        const result = passMove(current, turnPlayer.id);
        if (!result.ok) break;
        this.room.game = result.game;
      } else {
        this.room.game = skipLead(current);
      }
      changed = true;
    }
    return changed;
  }

  viewFor(playerId, action) {
    const game = this.room.game;
    const gamePlayers = new Map(game?.players.map((player) => [player.id, player]));
    const players = this.room.players.map((member) => {
      const gamePlayer = gamePlayers.get(member.id);
      return { id: member.id, name: member.name, avatar: member.avatar, connected: member.connected, handCount: gamePlayer?.hand?.length ?? 0, hand: member.id === playerId ? (gamePlayer?.hand || []) : undefined };
    });
    return { type: 'state', you: playerId, phase: this.room.phase, roomCode: this.room.roomCode, hostId: this.room.hostId, players, turnPlayerId: game ? game.players[game.turnIndex]?.id : null, currentPlay: game?.currentPlay || null, gameOver: game?.gameOver || false, winner: game?.winner || null, action: action || null };
  }

  broadcastState(action = null) { for (const session of this.sockets.values()) if (session.playerId) this.send(session.socket, this.viewFor(session.playerId, action)); }
  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { /* closed socket */ } }
  async save() { await this.state.storage.put('room', this.room); }
}

// ---------- Poki Duel ----------

function freshPokiBattle(players) {
  const battle = { ...initialRoom(), gameOver: false, winner: undefined, loser: undefined, lastAction: undefined };
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
  let changed = !Array.isArray(saved.players);
  const usedIds = new Set();
  const canonicalByOriginal = new Map();
  const originalIds = new Map();
  const players = (Array.isArray(saved.players) ? saved.players : []).slice(0, POKI_MAX_PLAYERS).map((raw = {}) => {
    const player = raw && typeof raw === 'object' ? raw : {};
    const rawId = typeof player.id === 'string' ? player.id.trim() : '';
    let id = ID_PATTERN.test(rawId) && !usedIds.has(rawId) ? rawId : crypto.randomUUID();
    while (usedIds.has(id)) id = crypto.randomUUID();
    usedIds.add(id);
    if (rawId && !canonicalByOriginal.has(rawId)) canonicalByOriginal.set(rawId, id);
    if (rawId) originalIds.set(id, rawId);
    const normalized = {
      id,
      monster: POKI_MONSTER_IDS.includes(player.monster) ? player.monster : 'emberfox',
      name: cleanName(player.name),
      connected: player.connected !== false,
    };
    if (id !== player.id || normalized.monster !== player.monster || normalized.name !== player.name || normalized.connected !== player.connected || 'accountId' in player || 'coins' in player || 'username' in player) changed = true;
    return normalized;
  });
  if (Array.isArray(saved.players) && saved.players.length !== players.length) changed = true;
  const boardOk = Array.isArray(saved.board) && saved.board.length === SIZE
    && saved.board.every((row) => Array.isArray(row) && row.length === SIZE && row.every((gem) => POKI_GEMS.has(gem)));
  if (!boardOk) changed = true;
  const board = boardOk ? saved.board.map((row) => [...row]) : createBoard();
  let lastAction = saved.lastAction && typeof saved.lastAction === 'object' ? saved.lastAction : undefined;
  if (lastAction?.player) {
    const canonicalPlayer = canonicalByOriginal.get(lastAction.player) || lastAction.player;
    if (canonicalPlayer !== lastAction.player) { lastAction = { ...lastAction, player: canonicalPlayer }; changed = true; }
  }
  const battle = { players, board, hp: {}, mana: {}, shield: {}, turn: 0, gameOver: false, winner: undefined, loser: undefined, lastAction };
  const read = (record, id, fallback, maximum) => {
    // A repaired persisted ID keeps the values that were stored under the
    // original key; fall back to the canonical ID for freshly-created seats.
    const value = Number(saved[record]?.[id]);
    const normalized = Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : fallback;
    if (!Number.isFinite(value) || value !== normalized) changed = true;
    return normalized;
  };
  for (const player of players) {
    const readKey = originalIds.get(player.id) || player.id;
    battle.hp[player.id] = read('hp', readKey, MONSTERS[player.monster].maxHp, MONSTERS[player.monster].maxHp);
    battle.mana[player.id] = read('mana', readKey, 0, 100);
    battle.shield[player.id] = read('shield', readKey, 0, 200);
  }
  battle.turn = Number.isInteger(saved.turn) && saved.turn >= 0 ? saved.turn : 0;
  if (!Number.isInteger(saved.turn) || saved.turn < 0) changed = true;
  const canonicalWinner = saved.winner ? canonicalByOriginal.get(saved.winner) || saved.winner : undefined;
  const canonicalLoser = saved.loser ? canonicalByOriginal.get(saved.loser) || saved.loser : undefined;
  const winner = players.some((player) => player.id === canonicalWinner) ? canonicalWinner : undefined;
  const loser = players.some((player) => player.id === canonicalLoser) && canonicalLoser !== winner ? canonicalLoser : undefined;
  battle.gameOver = Boolean(saved.gameOver) && Boolean(winner) && Boolean(loser);
  battle.winner = battle.gameOver ? winner : undefined;
  battle.loser = battle.gameOver ? loser : undefined;
  if (saved.gameOver !== battle.gameOver || saved.winner !== battle.winner || saved.loser !== battle.loser) changed = true;
  const expectedKeys = new Set(['players', 'board', 'hp', 'mana', 'shield', 'turn', 'gameOver', 'winner', 'loser', 'lastAction']);
  if (Object.keys(saved).some((key) => !expectedKeys.has(key))) changed = true;
  return { room: battle, changed };
}

function addPokiPlayer(battle, id, monster, name) {
  const state = { ...battle, players: [...battle.players] };
  state.players.push({ id, monster, name, connected: true });
  state.hp = { ...state.hp, [id]: MONSTERS[monster].maxHp };
  state.mana = { ...state.mana, [id]: 0 };
  state.shield = { ...state.shield, [id]: 0 };
  return state;
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
      const normalized = normalizePokiRoom(saved);
      this.battle = normalized.room;
      let changed = normalized.changed;
      if (this.battle.players.length && this.battle.players.some((player) => player.connected)) {
        // DO rehydration: no WebSocket survives an eviction/restart, so every
        // persisted seat is a ghost. Mark them offline so seats can be reclaimed.
        for (const player of this.battle.players) player.connected = false;
        changed = true;
      }
      if (changed) return state.storage.put('poki', this.battle);
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const code = pokiRoomCode(url.pathname) || url.searchParams.get('code');
    if (code) this.code = code;
    if (url.pathname === '/summary' && request.method === 'GET' && request.headers.get('x-internal-room') === '1') {
      return json(this.summary(url.searchParams.get('pid') || ''));
    }
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const session = { socket: server, id: null, closed: false };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_SIZE) { this.error(session, 'Yêu cầu quá lớn.', true); return; }
      this.queue = this.queue.catch(() => {}).then(() => this.onMessage(session, event.data));
    });
    server.addEventListener('close', () => this.onClose(session));
    server.addEventListener('error', () => this.onClose(session));
    return new Response(null, { status: 101, webSocket: client });
  }

  summary(playerId) {
    const players = this.battle.players.length;
    const existing = playerId ? this.battle.players.some((player) => player.id === playerId) : false;
    return {
      code: this.code || 'POKI??',
      players,
      maxPlayers: POKI_MAX_PLAYERS,
      phase: players >= POKI_MAX_PLAYERS ? 'game' : 'waiting',
      canJoin: existing || players < POKI_MAX_PLAYERS || this.battle.players.some((player) => player.connected === false),
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

  socketFor(id) {
    return [...this.sockets.values()].find((session) => session.id === id) || null;
  }

  async join(session, message) {
    const monster = String(message.monster || '');
    if (!POKI_MONSTER_IDS.includes(monster)) return this.error(session, 'Hãy chọn một Poki thú.', true);
    const id = cleanId(message.id);
    const name = cleanName(message.name);
    if (session.id && session.id !== id) return this.error(session, 'Kết nối này đã gắn với người chơi khác.', true);
    const existing = this.battle.players.find((player) => player.id === id);
    if (existing) {
      session.id = id;
      for (const other of this.sockets.values()) if (other !== session && other.id === id) other.id = null;
      // A reconnect may update the nickname, but cannot change creature stats
      // after a 1v1 battle has been created.
      if (this.battle.players.length < POKI_MAX_PLAYERS) existing.monster = monster;
      existing.name = name;
      existing.connected = true;
      await this.save();
      this.broadcastState();
      return;
    }
    const offline = this.battle.players.find((player) => player.connected === false);
    if (offline && this.battle.players.length < POKI_MAX_PLAYERS) {
      this.battle.players.splice(this.battle.players.indexOf(offline), 1);
      this.battle = freshPokiBattle(this.battle.players);
    }
    if (this.battle.players.length >= POKI_MAX_PLAYERS) {
      const offline = this.battle.players.find((player) => player.connected === false);
      if (!offline) return this.error(session, 'Bàn đã đủ 2 người. Hãy chọn bàn khác.', true);
      this.battle.players.splice(this.battle.players.indexOf(offline), 1);
    }
    session.id = id;
    for (const other of this.sockets.values()) if (other !== session && other.id === id) other.id = null;
    this.battle = addPokiPlayer(this.battle, id, monster, name);
    if (this.battle.players.length === POKI_MAX_PLAYERS) this.battle = freshPokiBattle(this.battle.players);
    await this.save();
    this.broadcastState();
  }

  async move(session, message) {
    if (!this.battle.players.some((player) => player.id === session.id)) return this.error(session, 'Bạn chưa vào bàn.');
    if (this.battle.players.length !== POKI_MAX_PLAYERS) return this.error(session, 'Bàn chưa đủ hai người chơi.');
    if (this.battle.gameOver) return this.error(session, 'Trận đấu đã kết thúc. Hãy đấu lại hoặc rời bàn.');
    let active = this.battle.players[this.battle.turn % POKI_MAX_PLAYERS];
    const previousTurn = this.battle.turn;
    if (active?.id !== session.id) {
      // A disconnected opponent cannot act — let the connected player take over so the table never stalls.
      const requester = this.battle.players.find((player) => player.id === session.id);
      if (!active || active.connected !== false || !requester) return this.error(session, 'Chưa đến lượt bạn.');
      this.battle.turn = this.battle.players.indexOf(requester);
      active = requester;
    }
    const { from, to } = message;
    if (!from || !to || !Number.isInteger(from.x) || !Number.isInteger(from.y) || !Number.isInteger(to.x) || !Number.isInteger(to.y)) { this.battle.turn = previousTurn; return this.error(session, 'Nước đi không hợp lệ.'); }
    const result = resolveSwap(this.battle.board, from, to);
    if (!result.valid) { this.battle.turn = previousTurn; return this.error(session, 'Đổi hai gem kề nhau để tạo bộ 3.'); }
    const self = this.battle.players.find((player) => player.id === session.id);
    const foe = this.battle.players.find((player) => player.id !== session.id);
    const hit = applyBattleDamage(this.battle, foe.id, result.damage);
    this.battle = {
      ...hit.state,
      board: result.board,
      hp: { ...hit.state.hp, [session.id]: Math.min(MONSTERS[self.monster].maxHp, this.battle.hp[session.id] + result.healing) },
      mana: { ...hit.state.mana, [session.id]: Math.min(100, this.battle.mana[session.id] + result.mana) },
      turn: this.battle.turn + 1,
      lastAction: { player: session.id, damage: result.damage, healing: result.healing, mana: result.mana, cleared: result.cleared, cascades: result.cascades, primaryKind: result.primaryKind, frames: result.frames },
    };
    await this.save();
    this.broadcastState();
  }

  async special(session) {
    if (!this.battle.players.some((player) => player.id === session.id)) return this.error(session, 'Bạn chưa vào bàn.');
    if (this.battle.players.length !== POKI_MAX_PLAYERS) return this.error(session, 'Bàn chưa đủ hai người chơi.');
    if (this.battle.gameOver) return this.error(session, 'Trận đấu đã kết thúc. Hãy đấu lại hoặc rời bàn.');
    let active = this.battle.players[this.battle.turn % POKI_MAX_PLAYERS];
    const previousTurn = this.battle.turn;
    if (active?.id !== session.id) {
      // A disconnected opponent cannot act — let the connected player take over so the table never stalls.
      const requester = this.battle.players.find((player) => player.id === session.id);
      if (!active || active.connected !== false || !requester) return this.error(session, 'Chưa đến lượt bạn.');
      this.battle.turn = this.battle.players.indexOf(requester);
      active = requester;
    }
    const player = this.battle.players.find((p) => p.id === session.id);
    const skill = applySpecial(player.monster, this.battle.mana[session.id]);
    if (!skill.valid) { this.battle.turn = previousTurn; return this.error(session, 'Cần đủ 100 Mana để dùng kỹ năng.'); }
    const result = applySpecialTurn(this.battle, session.id, this.battle.mana[session.id], skill);
    this.battle = {
      ...result.state,
      turn: this.battle.turn + 1,
      lastAction: { player: session.id, damage: skill.damage, healing: skill.healing, mana: 0, cleared: 0, cascades: 0, special: true, skillName: skill.name },
    };
    await this.save();
    this.broadcastState();
  }

  async restart(session) {
    if (!this.battle.players.some((player) => player.id === session.id)) return this.error(session, 'Bạn chưa vào bàn.');
    if (!this.battle.gameOver) return this.error(session, 'Trận hiện tại chưa kết thúc.');
    // A rematch never includes seats whose owners disconnected mid-match.
    const connected = this.battle.players.filter((player) => player.connected);
    if (connected.length < POKI_MAX_PLAYERS) return this.error(session, 'Cần 2 người đang kết nối để chơi trận mới.');
    this.battle = freshPokiBattle(connected);
    await this.save();
    this.broadcastState();
  }

  async leave(session) {
    this.removePlayer(session.id);
    this.sockets.delete(session.socket);
    await this.save();
    this.broadcastState();
    try { session.socket.close(1000, 'bye'); } catch { /* closed */ }
  }

  removePlayer(id) {
    const index = this.battle.players.findIndex((player) => player.id === id);
    if (index < 0) return;
    this.battle.players.splice(index, 1);
    const remaining = this.battle.players.map((player) => ({ ...player, connected: this.socketFor(player.id) != null || player.connected !== false }));
    this.battle = remaining.length ? freshPokiBattle(remaining) : initialRoom();
  }

  onClose(session) {
    if (session.closed) return;
    session.closed = true;
    this.sockets.delete(session.socket);
    if (!session.id) return;
    const player = this.battle.players.find((item) => item.id === session.id);
    if (!player) return;
    const stillConnected = [...this.sockets.values()].some((other) => other.id === session.id);
    if (stillConnected) return;
    if (this.battle.gameOver || this.battle.players.length < POKI_MAX_PLAYERS) {
      this.queue = this.queue
        .catch((error) => console.error('Poki close queue failed:', error))
        .then(async () => {
          this.removePlayer(session.id);
          await this.save();
          this.broadcastState();
        })
        .catch((error) => console.error('Poki close persistence failed:', error));
    } else {
      player.connected = false;
      this.queue = this.queue
        .catch((error) => console.error('Poki close queue failed:', error))
        .then(async () => {
          // Everyone left mid-battle: reset the table so newcomers can play.
          if (this.battle.players.length && !this.battle.players.some((item) => item.connected)) this.battle = initialRoom();
          await this.save();
          this.broadcastState();
        })
        .catch((error) => console.error('Poki close persistence failed:', error));
    }
  }

  viewFor(id) {
    return {
      type: 'state',
      you: id,
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

  broadcastState() { for (const session of this.sockets.values()) if (session.id) this.send(session.socket, this.viewFor(session.id)); }
  error(session, message, fatal = false) { this.send(session.socket, { type: 'error', message, ...(fatal ? { fatal: true } : {}) }); }
  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { /* closed socket */ } }
  async save() { await this.state.storage.put('poki', this.battle); }
}

// ---------- XO ----------

function freshXoGame(players) {
  let game = initialGame();
  for (const player of players) game = xoAddPlayer(game, player);
  return game;
}

function normalizeXoGame(saved) {
  if (!saved || typeof saved !== 'object') return { game: initialGame(), changed: false };
  let changed = !Array.isArray(saved.players);
  const usedIds = new Set();
  const players = (Array.isArray(saved.players) ? saved.players : []).slice(0, XO_MAX_PLAYERS).map((raw = {}, index) => {
    const player = raw && typeof raw === 'object' ? raw : {};
    const rawId = typeof player.id === 'string' ? player.id.trim() : '';
    let id = ID_PATTERN.test(rawId) && !usedIds.has(rawId) ? rawId : crypto.randomUUID();
    while (usedIds.has(id)) id = crypto.randomUUID();
    usedIds.add(id);
    const normalized = { id, name: cleanName(player.name), symbol: index === 1 ? 'O' : 'X', connected: player.connected !== false };
    if (id !== player.id || normalized.name !== player.name || normalized.symbol !== player.symbol || normalized.connected !== player.connected || 'accountId' in player || 'coins' in player || 'username' in player) changed = true;
    return normalized;
  });
  if (Array.isArray(saved.players) && saved.players.length !== players.length) changed = true;
  const boardOk = Array.isArray(saved.board) && saved.board.length === 9 && saved.board.every((cell) => cell === null || cell === 'X' || cell === 'O');
  if (!boardOk) changed = true;
  const board = boardOk && players.length === XO_MAX_PLAYERS ? [...saved.board] : Array(9).fill(null);
  if (boardOk && players.length !== XO_MAX_PLAYERS && saved.board.some(Boolean)) changed = true;
  const result = players.length === XO_MAX_PLAYERS ? xoEvaluateBoard(board, players) : { gameOver: false, winner: null, draw: false };
  const turn = Number.isInteger(saved.turn) && saved.turn >= 0 ? saved.turn : 0;
  if (!Number.isInteger(saved.turn) || saved.turn < 0) changed = true;
  const rawLastMove = saved.lastMove;
  const lastPlayer = rawLastMove && players.find((player) => player.id === rawLastMove.player);
  const lastMove = lastPlayer && Number.isInteger(rawLastMove.cell) && rawLastMove.cell >= 0 && rawLastMove.cell < 9 && board[rawLastMove.cell] === lastPlayer.symbol
    ? { player: lastPlayer.id, cell: rawLastMove.cell, symbol: lastPlayer.symbol }
    : null;
  if (JSON.stringify(rawLastMove ?? null) !== JSON.stringify(lastMove)) changed = true;
  const game = { board, players, turn, gameOver: result.gameOver, winner: result.winner, draw: result.draw, lastMove };
  if (saved.gameOver !== game.gameOver || saved.winner !== game.winner || saved.draw !== game.draw) changed = true;
  const expectedKeys = new Set(['board', 'players', 'turn', 'gameOver', 'winner', 'draw', 'lastMove']);
  if (Object.keys(saved).some((key) => !expectedKeys.has(key))) changed = true;
  return { game, changed };
}

export class XoRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.code = null;
    this.game = null;
    this.queue = Promise.resolve();
    this.ready = state.storage.get('xo').then((saved) => {
      const normalized = normalizeXoGame(saved);
      this.game = normalized.game;
      let changed = normalized.changed;
      if (this.game.players.length && this.game.players.some((player) => player.connected)) {
        // DO rehydration: no WebSocket survives an eviction/restart, so every
        // persisted seat is a ghost. Mark them offline so seats can be reclaimed.
        for (const player of this.game.players) player.connected = false;
        changed = true;
      }
      if (changed) return state.storage.put('xo', this.game);
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const code = xoRoomCode(url.pathname) || url.searchParams.get('code');
    if (code) this.code = code;
    if (url.pathname === '/summary' && request.method === 'GET' && request.headers.get('x-internal-room') === '1') {
      return json(this.summary(url.searchParams.get('pid') || ''));
    }
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const session = { socket: server, id: null, closed: false };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_SIZE) { this.error(session, 'Yêu cầu quá lớn.', true); return; }
      this.queue = this.queue.catch(() => {}).then(() => this.onMessage(session, event.data));
    });
    server.addEventListener('close', () => this.onClose(session));
    server.addEventListener('error', () => this.onClose(session));
    return new Response(null, { status: 101, webSocket: client });
  }

  summary(playerId) {
    const players = this.game.players.length;
    const existing = playerId ? this.game.players.some((player) => player.id === playerId) : false;
    return {
      code: this.code || 'XO??',
      players,
      maxPlayers: XO_MAX_PLAYERS,
      phase: players >= XO_MAX_PLAYERS ? 'game' : 'waiting',
      canJoin: existing || players < XO_MAX_PLAYERS || this.game.players.some((player) => player.connected === false),
      gameOver: Boolean(this.game.gameOver),
    };
  }

  async onMessage(session, raw) {
    try {
      const message = JSON.parse(raw);
      switch (message.type) {
        case 'join': await this.join(session, message); break;
        case 'move': await this.move(session, message); break;
        case 'restart': await this.restart(session); break;
        case 'leave': await this.leave(session); break;
        default: this.send(session.socket, { type: 'error', message: 'Yêu cầu không hợp lệ.' });
      }
    } catch {
      this.send(session.socket, { type: 'error', message: 'Không thể xử lý yêu cầu.' });
    }
  }

  socketFor(id) {
    return [...this.sockets.values()].find((session) => session.id === id) || null;
  }

  async join(session, message) {
    const id = cleanId(message.id);
    const name = cleanName(message.name);
    if (session.id && session.id !== id) return this.error(session, 'Kết nối này đã gắn với người chơi khác.', true);
    const existing = this.game.players.find((player) => player.id === id);
    if (existing) {
      session.id = id;
      for (const other of this.sockets.values()) if (other !== session && other.id === id) other.id = null;
      existing.name = name;
      existing.connected = true;
      await this.save();
      this.broadcastState();
      return;
    }
    const offline = this.game.players.find((player) => player.connected === false);
    if (offline && this.game.players.length < XO_MAX_PLAYERS) {
      this.game.players.splice(this.game.players.indexOf(offline), 1);
      this.game = freshXoGame(this.game.players);
    }
    if (this.game.players.length >= XO_MAX_PLAYERS) {
      const offline = this.game.players.find((player) => player.connected === false);
      if (!offline) return this.error(session, 'Bàn đã đủ 2 người. Hãy chọn bàn khác.', true);
      this.game.players.splice(this.game.players.indexOf(offline), 1);
    }
    session.id = id;
    for (const other of this.sockets.values()) if (other !== session && other.id === id) other.id = null;
    this.game = freshXoGame([...this.game.players, { id, name, connected: true }]);
    await this.save();
    this.broadcastState();
  }

  async move(session, message) {
    if (!this.game.players.some((player) => player.id === session.id)) return this.error(session, 'Bạn chưa vào bàn.');
    if (this.game.players.length !== XO_MAX_PLAYERS) return this.error(session, 'Bàn chưa đủ hai người chơi.');
    if (this.game.gameOver) return this.error(session, 'Trận đấu đã kết thúc. Hãy đấu lại hoặc rời bàn.');
    const active = this.game.players[this.game.turn % Math.max(1, this.game.players.length)];
    const previousTurn = this.game.turn;
    if (active?.id !== session.id) {
      // A disconnected opponent cannot act — let the connected player take over so the table never stalls.
      const requester = this.game.players.find((player) => player.id === session.id);
      if (!active || active.connected !== false || !requester) return this.error(session, 'Chưa đến lượt bạn.');
      this.game.turn = this.game.players.indexOf(requester);
    }
    const result = xoMove(this.game, session.id, message.cell);
    if (!result.ok) { this.game.turn = previousTurn; return this.error(session, result.error); }
    this.game = result.game;
    await this.save();
    this.broadcastState();
  }

  async restart(session) {
    if (!this.game.players.some((player) => player.id === session.id)) return this.error(session, 'Bạn chưa vào bàn.');
    if (!this.game.gameOver) return this.error(session, 'Trận hiện tại chưa kết thúc.');
    // A rematch never includes seats whose owners disconnected mid-match.
    const connected = this.game.players.filter((player) => player.connected);
    if (connected.length < XO_MAX_PLAYERS) return this.error(session, 'Cần 2 người đang kết nối để chơi trận mới.');
    this.game = freshXoGame(connected);
    await this.save();
    this.broadcastState();
  }

  async leave(session) {
    this.removePlayer(session.id);
    this.sockets.delete(session.socket);
    await this.save();
    this.broadcastState();
    try { session.socket.close(1000, 'bye'); } catch { /* closed */ }
  }

  removePlayer(id) {
    const index = this.game.players.findIndex((player) => player.id === id);
    if (index < 0) return;
    this.game.players.splice(index, 1);
    const remaining = this.game.players.map((player) => ({ ...player, connected: this.socketFor(player.id) != null || player.connected !== false }));
    this.game = remaining.length ? freshXoGame(remaining) : initialGame();
  }

  onClose(session) {
    if (session.closed) return;
    session.closed = true;
    this.sockets.delete(session.socket);
    if (!session.id) return;
    const player = this.game.players.find((item) => item.id === session.id);
    if (!player) return;
    const stillConnected = [...this.sockets.values()].some((other) => other.id === session.id);
    if (stillConnected) return;
    if (this.game.gameOver || this.game.players.length < XO_MAX_PLAYERS) {
      this.queue = this.queue
        .catch((error) => console.error('XO close queue failed:', error))
        .then(async () => {
          this.removePlayer(session.id);
          await this.save();
          this.broadcastState();
        })
        .catch((error) => console.error('XO close persistence failed:', error));
    } else {
      player.connected = false;
      this.queue = this.queue
        .catch((error) => console.error('XO close queue failed:', error))
        .then(async () => {
          // Everyone left mid-game: reset the table so newcomers can play.
          if (this.game.players.length && !this.game.players.some((item) => item.connected)) this.game = initialGame();
          await this.save();
          this.broadcastState();
        })
        .catch((error) => console.error('XO close persistence failed:', error));
    }
  }

  viewFor(id) {
    return {
      type: 'state',
      you: id,
      roomCode: this.code,
      game: {
        players: this.game.players.map((player) => ({ id: player.id, name: player.name, symbol: player.symbol, connected: player.connected })),
        board: this.game.board,
        turn: this.game.turn,
        gameOver: this.game.gameOver,
        winner: this.game.winner,
        draw: this.game.draw,
        lastMove: this.game.lastMove,
      },
    };
  }

  broadcastState() { for (const session of this.sockets.values()) if (session.id) this.send(session.socket, this.viewFor(session.id)); }
  error(session, message, fatal = false) { this.send(session.socket, { type: 'error', message, ...(fatal ? { fatal: true } : {}) }); }
  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { /* closed socket */ } }
  async save() { await this.state.storage.put('xo', this.game); }
}

// ---------- public room summaries ----------

// One probe per game family; a broken table degrades to a non-joinable
// placeholder instead of exposing a broken entry in the lobby list.
async function roomSummary(env, binding, code, playerId, unavailable) {
  const headers = new Headers({ 'x-internal-room': '1' });
  try {
    const response = await env[binding].get(env[binding].idFromName(code)).fetch(new Request(`https://room/summary?code=${code}&pid=${encodeURIComponent(playerId || '')}`, { headers }));
    if (response.ok) return response.json();
  } catch {
    // Report an unavailable table as non-joinable instead of exposing a broken entry.
  }
  return { code, ...unavailable };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/rooms') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const pid = url.searchParams.get('pid') || '';
      const rooms = await Promise.all(ROOM_CODES.map((code) => roomSummary(env, 'ROOMS', code, pid, { players: 0, maxPlayers: MAX_PLAYERS, phase: 'unavailable', canJoin: false })));
      return json({ rooms });
    }
    if (url.pathname === '/api/poki/rooms') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const pid = url.searchParams.get('pid') || '';
      const rooms = await Promise.all(POKI_ROOM_CODES.map((code) => roomSummary(env, 'POKI_ROOMS', code, pid, { players: 0, maxPlayers: POKI_MAX_PLAYERS, phase: 'unavailable', canJoin: false, gameOver: false })));
      return json({ rooms });
    }
    if (url.pathname === '/api/xo/rooms') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const pid = url.searchParams.get('pid') || '';
      const rooms = await Promise.all(XO_ROOM_CODES.map((code) => roomSummary(env, 'XO_ROOMS', code, pid, { players: 0, maxPlayers: XO_MAX_PLAYERS, phase: 'unavailable', canJoin: false, gameOver: false })));
      return json({ rooms });
    }
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return json({ ok: true, service: 'game', games: ['tienlen', 'poki', 'xo'] });
    }
    const pokiCode = pokiRoomCode(url.pathname);
    if (pokiCode) {
      if (!POKI_ROOM_CODES.includes(pokiCode.toUpperCase())) return json({ error: 'Không tìm thấy bàn này.' }, 404);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      return env.POKI_ROOMS.get(env.POKI_ROOMS.idFromName(pokiCode.toUpperCase())).fetch(request);
    }
    const xoCode = xoRoomCode(url.pathname);
    if (xoCode) {
      if (!XO_ROOM_CODES.includes(xoCode.toUpperCase())) return json({ error: 'Không tìm thấy bàn này.' }, 404);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      return env.XO_ROOMS.get(env.XO_ROOMS.idFromName(xoCode.toUpperCase())).fetch(request);
    }
    const code = roomCode(url.pathname);
    if (code) {
      if (!ROOM_CODES.includes(code.toUpperCase())) return json({ error: 'Không tìm thấy bàn này.' }, 404);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    if (url.pathname === '/poki' || url.pathname === '/poki/') {
      return env.ASSETS.fetch(new Request(new URL('/poki/index.html', url), request));
    }
    if (url.pathname === '/xo' || url.pathname === '/xo/') {
      return env.ASSETS.fetch(new Request(new URL('/xo/index.html', url), request));
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Không tìm thấy API này.' }, 404);
    return env.ASSETS.fetch(request);
  },
};
