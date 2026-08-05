// Poki Duel — five fixed 1v1 tables. Shared by the Worker (PokiRoom routes) and the browser client.
export const POKI_ROOM_CODES = Object.freeze(['POKI01', 'POKI02', 'POKI03', 'POKI04', 'POKI05']);

export function pokiGamePath() {
  return '/poki';
}

export function pokiRoomUrl(code) {
  return `${pokiGamePath()}/?room=${String(code).toUpperCase()}`;
}

export function pokiTableLabel(index) {
  return `Bàn ${String(index + 1).padStart(2, '0')}`;
}

export function isPokiRoomCode(value) {
  return POKI_ROOM_CODES.includes(String(value).toUpperCase());
}
