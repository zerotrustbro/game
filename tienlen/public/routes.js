export const ROOM_CODES = Object.freeze(['BAN01', 'BAN02', 'BAN03', 'BAN04', 'BAN05']);
const ROOM_PATTERN = /^[A-Z0-9]{4,8}$/;

export function roomPath(code) {
  return `/tienlen/room/${String(code).toUpperCase()}`;
}

export function gamePath() {
  return '/tienlen';
}

export function parseRoute(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { page: 'hub', roomCode: null };
  if (path === '/tienlen') return { page: 'tienlen', roomCode: null };
  const room = path.match(/^\/tienlen\/room\/([A-Za-z0-9]+)$/);
  if (room && ROOM_PATTERN.test(room[1].toUpperCase())) {
    return { page: 'tienlen', roomCode: room[1].toUpperCase() };
  }
  return { page: 'not-found', roomCode: null };
}
