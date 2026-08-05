import { dealGame, passMove, playMove } from '../tienlen/public/engine.js';
import { ROOM_CODES } from '../tienlen/public/routes.js';
import { applyBattleDamage, applySpecial, applySpecialTurn, createBoard, initialRoom, MONSTERS, resolveSwap, SIZE } from '../poki/public/game.js';
import { POKI_ROOM_CODES } from '../poki/public/routes.js';
import { addPlayer as xoAddPlayer, initialGame, makeMove as xoMove, restartGame as xoRestart } from '../xo/public/game.js';
import { XO_ROOM_CODES } from '../xo/public/routes.js';

const MAX_PLAYERS = 4;
const POKI_MAX_PLAYERS = 2;
const XO_MAX_PLAYERS = 2;
const POKI_MONSTER_IDS = Object.freeze(Object.keys(MONSTERS));
const POKI_GEMS = new Set(['sword', 'heart', 'mana']);
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

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
  const match = pathname.match(/^\/api\/room\/([A-Z0-9]{4,8})$/);
  return match?.[1] || null;
}

function pokiRoomCode(pathname) {
  const match = pathname.match(/^\/api\/poki\/room\/([A-Z0-9-]{1,12})$/);
  return match?.[1] || null;
}

function xoRoomCode(pathname) {
  const match = pathname.match(/^\/api\/xo\/room\/([A-Z0-9]{4,8})$/);
  return match?.[1] || null;
}

function emptyRoom() {
  return { phase: 'lobby', hostId: null, players: [], game: null, roomCode: null, roundId: null };
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
    let id = typeof originalId === 'string' && ID_PATTERN.test(originalId) && !usedIds.has(originalId) ? originalId : crypto.randomUUID();
    while (usedIds.has(id)) id = crypto.randomUUID();
    if (typeof originalId === 'string' && !canonicalByOriginal.has(originalId)) canonicalByOriginal.set(originalId, id);
    usedIds.add(id);
    if (id !== originalId || 'accountId' in player || 'coins' in player || 'username' in player) changed = true;
    return { id, name: cleanName(player.name), avatar: cleanAvatar(player.avatar), connected: player.connected !== false };
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
      const member = player.accountId ? players.find((candidate) => candidate.id === player.accountId) : players[index];
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
      return json(this.summary(url.searchParams.get('code') || this.room.roomCode, url.searchParams.get('pid') || ''));
    }
    this.room.roomCode = roomCode(url.pathname) || this.room.roomCode;
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const session = { socket: server, playerId: null };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
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
    const id = cleanId(message.id);
    const existing = this.room.players.find((player) => player.id === id);
    if (!existing && this.room.players.length >= MAX_PLAYERS) return this.send(session.socket, { type: 'error', message: 'Phòng đã đủ 4 người.' });
    if (this.room.phase === 'game' && !existing) return this.send(session.socket, { type: 'error', message: 'Ván đã bắt đầu, hãy vào ván kế tiếp.' });
    const playerId = existing?.id || id;
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
    if (this.room.players.length < 2) return this.error(session, 'Cần ít nhất 2 người để bắt đầu.');
    await this.beginRound();
  }

  async play(session, cards) {
    if (!this.isKnown(session) || this.room.phase !== 'game') return this.error(session, 'Chưa có ván đang chơi.');
    const result = playMove(this.room.game, session.playerId, cards);
    if (!result.ok) return this.error(session, result.error);
    this.room.game = result.game;
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
    await this.beginRound();
  }

  gamePlayers() {
    return this.room.players.map(({ id, name, avatar }) => ({ id, name, avatar }));
  }

  async beginRound() {
    this.room.game = dealGame(this.gamePlayers());
    this.room.roundId = crypto.randomUUID();
    this.room.phase = 'game';
    await this.save();
    this.broadcastState();
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
            // Everyone left: reset the table so newcomers can play.
            if (this.room.players.length && !this.room.players.some((item) => item.connected)) {
              const code = this.room.roomCode;
              this.room = emptyRoom();
              this.room.roomCode = code;
            }
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
      return { id: member.id, name: member.name, avatar: member.avatar, connected: member.connected, handCount: gamePlayer?.hand.length ?? 0, hand: member.id === playerId ? (gamePlayer?.hand || []) : undefined };
    });
    return { type: 'state', you: playerId, phase: this.room.phase, roomCode: this.room.roomCode, hostId: this.room.hostId, players, turnPlayerId: game ? game.players[game.turnIndex]?.id : null, currentPlay: game?.currentPlay || null, gameOver: game?.gameOver || false, winner: game?.winner || null, action: action || null };
  }

  broadcastState(action = null) { for (const session of this.sockets.values()) if (session.playerId) this.send(session.socket, this.viewFor(session.playerId, action)); }
  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { /* closed socket */ } }
  async save() { await this.state.storage.put('room', this.room); }
}

// ---------- Poki Duel ----------

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
      this.battle = normalizePokiRoom(saved).room;
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
    const session = { socket: server, id: null };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
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

  socketFor(id) {
    return [...this.sockets.values()].find((session) => session.id === id) || null;
  }

  async join(session, message) {
    const monster = String(message.monster || '');
    if (!POKI_MONSTER_IDS.includes(monster)) return this.error(session, 'Hãy chọn một Poki thú.', true);
    const id = cleanId(message.id);
    const name = cleanName(message.name);
    session.id = id;
    const existing = this.battle.players.find((player) => player.id === id);
    if (existing) {
      existing.monster = monster;
      existing.name = name;
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
    this.battle = addPokiPlayer(this.battle, id, monster, name);
    if (this.battle.players.length === POKI_MAX_PLAYERS) this.battle = freshPokiBattle(this.battle.players);
    await this.save();
    this.broadcastState();
  }

  async move(session, message) {
    if (this.battle.players.length !== POKI_MAX_PLAYERS) return this.error(session, 'Bàn chưa đủ hai người chơi.');
    const active = this.battle.players[this.battle.turn % POKI_MAX_PLAYERS];
    if (active?.id !== session.id) return this.error(session, 'Chưa đến lượt bạn.');
    if (this.battle.gameOver) return this.error(session, 'Trận đấu đã kết thúc. Hãy đấu lại hoặc rời bàn.');
    const { from, to } = message;
    if (!from || !to || !Number.isInteger(from.x) || !Number.isInteger(from.y) || !Number.isInteger(to.x) || !Number.isInteger(to.y)) return this.error(session, 'Nước đi không hợp lệ.');
    const result = resolveSwap(this.battle.board, from, to);
    if (!result.valid) return this.error(session, 'Đổi hai gem kề nhau để tạo bộ 3.');
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
    if (this.battle.players.length !== POKI_MAX_PLAYERS) return this.error(session, 'Bàn chưa đủ hai người chơi.');
    const active = this.battle.players[this.battle.turn % POKI_MAX_PLAYERS];
    if (active?.id !== session.id) return this.error(session, 'Chưa đến lượt bạn.');
    if (this.battle.gameOver) return this.error(session, 'Trận đấu đã kết thúc. Hãy đấu lại hoặc rời bàn.');
    const player = this.battle.players.find((p) => p.id === session.id);
    const skill = applySpecial(player.monster, this.battle.mana[session.id]);
    if (!skill.valid) return this.error(session, 'Cần đủ 100 Mana để dùng kỹ năng.');
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
    if (!this.battle.gameOver) return this.error(session, 'Trận hiện tại chưa kết thúc.');
    this.battle = freshPokiBattle(this.battle.players);
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
    const remaining = this.battle.players.map(({ id: pid, monster, name }) => ({ id: pid, monster, name, connected: this.socketFor(pid) != null }));
    this.battle = remaining.length ? freshPokiBattle(remaining) : initialRoom();
  }

  onClose(session) {
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
  const players = Array.isArray(saved.players)
    ? saved.players.slice(0, XO_MAX_PLAYERS).map((player = {}) => ({
        id: String(player.id || crypto.randomUUID()).slice(0, 64),
        name: cleanName(player.name),
        symbol: player.symbol === 'O' ? 'O' : 'X',
        connected: player.connected !== false,
      }))
    : [];
  const boardOk = Array.isArray(saved.board) && saved.board.length === 9 && saved.board.every((cell) => cell === null || cell === 'X' || cell === 'O');
  const game = {
    board: boardOk ? [...saved.board] : Array(9).fill(null),
    players,
    turn: Number.isInteger(saved.turn) && saved.turn >= 0 ? saved.turn : 0,
    gameOver: Boolean(saved.gameOver) && players.length > 0,
    winner: players.some((player) => player.id === saved.winner) ? saved.winner : null,
    draw: Boolean(saved.draw),
    lastMove: null,
  };
  if (!boardOk) game.turn = 0;
  return { game, changed: false };
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
      this.game = normalizeXoGame(saved).game;
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
    const session = { socket: server, id: null };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
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
      canJoin: existing || players < XO_MAX_PLAYERS,
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
    session.id = id;
    const existing = this.game.players.find((player) => player.id === id);
    if (existing) {
      existing.name = name;
      existing.connected = true;
      await this.save();
      this.broadcastState();
      return;
    }
    if (this.game.players.length >= XO_MAX_PLAYERS) {
      const offline = this.game.players.find((player) => player.connected === false);
      if (!offline) return this.error(session, 'Bàn đã đủ 2 người. Hãy chọn bàn khác.', true);
      this.game.players.splice(this.game.players.indexOf(offline), 1);
    }
    this.game = freshXoGame([...this.game.players, { id, name, connected: true }]);
    await this.save();
    this.broadcastState();
  }

  async move(session, message) {
    if (this.game.players.length !== XO_MAX_PLAYERS) return this.error(session, 'Bàn chưa đủ hai người chơi.');
    const result = xoMove(this.game, session.id, message.cell);
    if (!result.ok) return this.error(session, result.error);
    this.game = result.game;
    await this.save();
    this.broadcastState();
  }

  async restart(session) {
    if (!this.game.gameOver) return this.error(session, 'Trận hiện tại chưa kết thúc.');
    this.game = freshXoGame(this.game.players);
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
    const remaining = this.game.players.map(({ id: pid, name }) => ({ id: pid, name, connected: this.socketFor(pid) != null }));
    this.game = remaining.length ? freshXoGame(remaining) : initialGame();
  }

  onClose(session) {
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

async function roomSummary(env, code, playerId) {
  const headers = new Headers({ 'x-internal-room': '1' });
  try {
    const response = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(`https://room/summary?code=${code}&pid=${encodeURIComponent(playerId || '')}`, { headers }));
    if (response.ok) return response.json();
  } catch {
    // Report an unavailable table as non-joinable instead of exposing a broken entry.
  }
  return { code, players: 0, maxPlayers: MAX_PLAYERS, phase: 'unavailable', canJoin: false };
}

async function pokiRoomSummary(env, code, playerId) {
  const headers = new Headers({ 'x-internal-room': '1' });
  try {
    const response = await env.POKI_ROOMS.get(env.POKI_ROOMS.idFromName(code)).fetch(new Request(`https://pokiroom/summary?code=${code}&pid=${encodeURIComponent(playerId || '')}`, { headers }));
    if (response.ok) return response.json();
  } catch {
    // Report an unavailable table as non-joinable instead of exposing a broken entry.
  }
  return { code, players: 0, maxPlayers: POKI_MAX_PLAYERS, phase: 'unavailable', canJoin: false, gameOver: false };
}

async function xoRoomSummary(env, code, playerId) {
  const headers = new Headers({ 'x-internal-room': '1' });
  try {
    const response = await env.XO_ROOMS.get(env.XO_ROOMS.idFromName(code)).fetch(new Request(`https://xoroom/summary?code=${code}&pid=${encodeURIComponent(playerId || '')}`, { headers }));
    if (response.ok) return response.json();
  } catch {
    // Report an unavailable table as non-joinable instead of exposing a broken entry.
  }
  return { code, players: 0, maxPlayers: XO_MAX_PLAYERS, phase: 'unavailable', canJoin: false, gameOver: false };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      const pid = url.searchParams.get('pid') || '';
      const rooms = await Promise.all(ROOM_CODES.map((code) => roomSummary(env, code, pid)));
      return json({ rooms });
    }
    if (url.pathname === '/api/poki/rooms' && request.method === 'GET') {
      const pid = url.searchParams.get('pid') || '';
      const rooms = await Promise.all(POKI_ROOM_CODES.map((code) => pokiRoomSummary(env, code, pid)));
      return json({ rooms });
    }
    if (url.pathname === '/api/xo/rooms' && request.method === 'GET') {
      const pid = url.searchParams.get('pid') || '';
      const rooms = await Promise.all(XO_ROOM_CODES.map((code) => xoRoomSummary(env, code, pid)));
      return json({ rooms });
    }
    if (url.pathname === '/api/health') return json({ ok: true, service: 'game', games: ['tienlen', 'poki', 'xo'] });
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
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    if (url.pathname === '/poki' || url.pathname === '/poki/') {
      return env.ASSETS.fetch(new Request(new URL('/poki/index.html', url), request));
    }
    if (url.pathname === '/xo' || url.pathname === '/xo/') {
      return env.ASSETS.fetch(new Request(new URL('/xo/index.html', url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
