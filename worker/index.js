import { dealGame, passMove, playMove } from '../tienlen/public/engine.js';

const MAX_PLAYERS = 4;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function cleanName(value) {
  return String(value || 'Người chơi').trim().replace(/[<>]/g, '').slice(0, 18) || 'Người chơi';
}

function cleanAvatar(value) {
  const avatar = Number(value);
  return Number.isInteger(avatar) && avatar >= 1 && avatar <= 8 ? avatar : 1;
}

function roomCode(pathname) {
  const match = pathname.match(/^\/api\/room\/([A-Z0-9]{4,8})$/);
  return match?.[1] || null;
}

export class Room {
  constructor(state) {
    this.state = state;
    this.sockets = new Map();
    this.room = null;
    this.queue = Promise.resolve();
    this.ready = state.storage.get('room').then((saved) => {
      this.room = saved || { phase: 'lobby', hostId: null, players: [], game: null };
    });
  }

  async fetch(request) {
    await this.ready;
    this.room.roomCode = roomCode(new URL(request.url).pathname) || this.room.roomCode;
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const session = { socket: server, playerId: null };
    this.sockets.set(server, session);
    server.addEventListener('message', (event) => {
      this.queue = this.queue.then(() => this.onMessage(session, event.data));
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
    const playerId = String(message.playerId || crypto.randomUUID()).slice(0, 64);
    const existing = this.room.players.find((player) => player.id === playerId);
    if (!existing && this.room.players.length >= MAX_PLAYERS) {
      this.send(session.socket, { type: 'error', message: 'Phòng đã đủ 4 người.' });
      return;
    }
    if (this.room.phase === 'game' && !existing) {
      this.send(session.socket, { type: 'error', message: 'Ván đã bắt đầu, hãy vào ván kế tiếp.' });
      return;
    }
    if (existing) {
      existing.name = cleanName(message.name || existing.name);
      existing.avatar = cleanAvatar(message.avatar || existing.avatar);
      existing.connected = true;
    } else {
      const player = { id: playerId, name: cleanName(message.name), avatar: cleanAvatar(message.avatar), connected: true };
      this.room.players.push(player);
      if (!this.room.hostId) this.room.hostId = playerId;
    }
    session.playerId = playerId;
    for (const other of this.sockets.values()) {
      if (other !== session && other.playerId === playerId) other.playerId = null;
    }
    await this.save();
    this.broadcastState();
  }

  async start(session) {
    if (!this.isKnown(session) || this.room.hostId !== session.playerId) return this.error(session, 'Chỉ chủ phòng mới có thể bắt đầu.');
    if (this.room.players.length < 2) return this.error(session, 'Cần ít nhất 2 người để bắt đầu.');
    const players = this.room.players.map(({ id, name, avatar }) => ({ id, name, avatar }));
    this.room.game = dealGame(players);
    this.room.phase = 'game';
    await this.save();
    this.broadcastState();
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
    const players = this.room.players.map(({ id, name, avatar }) => ({ id, name, avatar }));
    this.room.game = dealGame(players);
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
        if (this.room.hostId === session.playerId) {
          this.room.hostId = this.room.players.find((item) => item.connected)?.id || null;
        }
        this.save().then(() => this.broadcastState());
      }
    }
  }

  isKnown(session) {
    return Boolean(session.playerId && this.room.players.some((player) => player.id === session.playerId));
  }

  error(session, message) {
    this.send(session.socket, { type: 'error', message });
  }

  viewFor(playerId, action) {
    const game = this.room.game;
    const players = this.room.players.map((member) => {
      const gamePlayer = game?.players.find((player) => player.id === member.id);
      return {
        id: member.id,
        name: member.name,
        avatar: member.avatar,
        connected: member.connected,
        handCount: gamePlayer?.hand.length ?? 0,
        hand: member.id === playerId ? (gamePlayer?.hand || []) : undefined,
      };
    });
    return {
      type: 'state',
      phase: this.room.phase,
      roomCode: this.room.roomCode,
      hostId: this.room.hostId,
      players,
      turnPlayerId: game ? game.players[game.turnIndex]?.id : null,
      currentPlay: game?.currentPlay || null,
      gameOver: game?.gameOver || false,
      winner: game?.winner || null,
      action: action || null,
    };
  }

  broadcastState(action = null) {
    for (const session of this.sockets.values()) {
      if (session.playerId) this.send(session.socket, this.viewFor(session.playerId, action));
    }
  }

  send(socket, message) {
    try { socket.send(JSON.stringify(message)); } catch { /* closed socket */ }
  }

  async save() {
    await this.state.storage.put('room', this.room);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true, service: 'game', game: 'tienlen' });
    const code = roomCode(url.pathname);
    if (code) {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
