// Local preview server for the Game Room ecosystem (no wrangler needed).
// Serves the built frontend from dist/ and wires the REAL AccountStore + PokiRoom
// Durable Object classes from worker/index.js over plain HTTP + WebSocket (ws).
//
//   npm run build && node scripts/dev-mock.mjs
//   open http://localhost:8798/
//
// Why: `wrangler dev` currently crashes on Windows (libuv assertion in wrangler 4.118),
// so this mock gives the same surface — auth, 5-table poki lobby, realtime 1v1 battle —
// against the exact same worker code that ships to Cloudflare.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AccountStore, PokiRoom } from '../worker/index.js';
import { POKI_ROOM_CODES } from '../poki/public/routes.js';

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

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(bytes));
}

function parseCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

const accounts = new AccountStore({ storage: memStorage('accounts') });
await accounts.ready;

async function resolveAccount(cookieHeader) {
  const token = parseCookie(cookieHeader, 'game_session');
  if (!token) return null;
  const session = accounts.data.sessions[await sha256(token)];
  if (!session || session.expiresAt <= Date.now()) return null;
  return accounts.data.users[session.userId] || null;
}

const rooms = new Map();
async function getRoom(code) {
  if (!rooms.has(code)) {
    const room = new PokiRoom({ storage: memStorage('poki') }, {});
    room.code = code;
    await room.ready;
    rooms.set(code, room);
  }
  return rooms.get(code);
}

// -- HTTP -- //
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/auth/')) {
        const target = new URL(`https://accounts${url.pathname.replace('/api/auth', '')}`);
        target.searchParams.set('client_proto', 'http:');
        const headers = new Headers(req.headers);
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
        const response = await accounts.fetch(new Request(target, { method: req.method, headers, body }));
        const cookie = response.headers.get('set-cookie');
        res.writeHead(response.status, {
          'content-type': 'application/json',
          ...(cookie ? { 'set-cookie': cookie } : {}),
        });
        res.end(JSON.stringify(await response.json()));
        return;
      }
      if (url.pathname === '/api/poki/rooms' && req.method === 'GET') {
        const account = await resolveAccount(req.headers.cookie);
        const roomsList = await Promise.all(POKI_ROOM_CODES.map(async (code) => (await getRoom(code)).summary(account?.id || null)));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rooms: roomsList }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found in dev mock.' }));
      return;
    }
    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if (pathname === '/poki' || pathname === '/poki/') pathname = '/poki/index.html';
    const file = path.join(root, pathname);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found. Run `npm run build` first so dist/ exists.');
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// -- WebSocket (poki rooms) -- //
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
    const match = url.pathname.match(/^\/api\/poki\/room\/([A-Z0-9-]{1,12})$/);
    const code = match ? match[1].toUpperCase() : null;
    if (!code || !POKI_ROOM_CODES.includes(code)) return socket.destroy();
    const account = await resolveAccount(req.headers.cookie);
    if (!account) return socket.destroy();
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const room = await getRoom(code);
      const adapter = new SocketAdapter(ws);
      const session = { socket: adapter, account: { id: account.id, username: account.username, displayName: account.displayName } };
      room.sockets.set(adapter, session);
      adapter.addEventListener('message', (event) => {
        room.queue = room.queue.catch(() => {}).then(() => room.onMessage(session, String(event.data)));
      });
      adapter.addEventListener('close', () => room.onClose(session));
      adapter.addEventListener('error', () => room.onClose(session));
      adapter.send(JSON.stringify(room.viewFor(session.account.id)));
    });
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Game Room dev mock on http://localhost:${PORT}/  (poki: http://localhost:${PORT}/poki/)`);
});
