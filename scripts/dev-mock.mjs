// Local preview server for the Game Room ecosystem (no wrangler needed).
// Serves the built frontend from dist/ and wires the REAL Room + PokiRoom + XoRoom
// Durable Object classes from worker/index.js over plain HTTP + WebSocket (ws).
//
//   npm run build && node scripts/dev-mock.mjs
//   open http://localhost:8798/
//
// Why: `wrangler dev` currently crashes on Windows (libuv assertion in wrangler 4.118),
// so this mock gives the same surface — 5-table lobbies and realtime games for
// Tiến Lên / Poki / XO — against the exact same worker code that ships to Cloudflare.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, PokiRoom, XoRoom } from '../worker/index.js';
import { ROOM_CODES } from '../tienlen/public/routes.js';
import { POKI_ROOM_CODES } from '../poki/public/routes.js';
import { XO_ROOM_CODES } from '../xo/public/routes.js';

const PORT = Number(process.env.PORT || 8798);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function memStorage(namespace) {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
  };
}

const rooms = new Map();
const pokiRooms = new Map();
const xoRooms = new Map();

async function getRoom(map, ctor, key) {
  if (!map.has(key)) {
    const room = new ctor({ storage: memStorage(key) }, {});
    room.code = key;
    await room.ready;
    map.set(key, room);
  }
  return map.get(key);
}

// -- HTTP -- //
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/rooms' && req.method === 'GET') {
        const pid = url.searchParams.get('pid') || '';
        const list = await Promise.all(ROOM_CODES.map(async (code) => (await getRoom(rooms, Room, code)).summary(code, pid)));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rooms: list }));
        return;
      }
      if (url.pathname === '/api/poki/rooms' && req.method === 'GET') {
        const pid = url.searchParams.get('pid') || '';
        const list = await Promise.all(POKI_ROOM_CODES.map(async (code) => (await getRoom(pokiRooms, PokiRoom, code)).summary(pid)));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rooms: list }));
        return;
      }
      if (url.pathname === '/api/xo/rooms' && req.method === 'GET') {
        const pid = url.searchParams.get('pid') || '';
        const list = await Promise.all(XO_ROOM_CODES.map(async (code) => (await getRoom(xoRooms, XoRoom, code)).summary(pid)));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rooms: list }));
        return;
      }
      if (url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'game', games: ['tienlen', 'poki', 'xo'] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found in dev mock.' }));
      return;
    }
    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if (pathname === '/poki' || pathname === '/poki/') pathname = '/poki/index.html';
    if (pathname === '/xo' || pathname === '/xo/') pathname = '/xo/index.html';
    const file = path.join(root, pathname);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found. Run `npm run build` first so dist/ exists.');
  }
});

// -- WebSocket -- //
class SocketAdapter {
  constructor(ws) {
    this.ws = ws;
    this.listeners = {};
    ws.on('message', (data) => this.emit('message', { data }));
    ws.on('close', () => this.emit('close'));
    ws.on('error', () => this.emit('error'));
  }
  accept() {}
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  send(data) {
    this.ws.send(data);
  }
  close(code, reason) {
    try { this.ws.close(code, reason); } catch { /* closed */ }
  }
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const attach = async (pattern, roomMap, ctor) => {
      const match = url.pathname.match(pattern);
      const code = match ? match[1].toUpperCase() : null;
      if (!code) return false;
      const allowed = code.startsWith('BAN') ? ROOM_CODES : code.startsWith('POKI') ? POKI_ROOM_CODES : XO_ROOM_CODES;
      if (!allowed.includes(code)) { socket.destroy(); return true; }
      const room = await getRoom(roomMap, ctor, code);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const adapter = new SocketAdapter(ws);
        const session = { socket: adapter, playerId: null, id: null };
        room.sockets.set(adapter, session);
        adapter.addEventListener('message', (event) => {
          room.queue = room.queue.catch(() => {}).then(() => room.onMessage(session, String(event.data)));
        });
        adapter.addEventListener('close', () => room.onClose(session));
        adapter.addEventListener('error', () => room.onClose(session));
      });
      return true;
    };
    if (await attach(/^\/api\/room\/([A-Za-z0-9]{4,8})$/, rooms, Room)) return;
    if (await attach(/^\/api\/poki\/room\/([A-Za-z0-9-]{1,12})$/, pokiRooms, PokiRoom)) return;
    if (await attach(/^\/api\/xo\/room\/([A-Za-z0-9]{4,8})$/, xoRooms, XoRoom)) return;
    socket.destroy();
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Game Room dev mock on http://localhost:${PORT}/  (poki: /poki/ · xo: /xo/)`);
});
