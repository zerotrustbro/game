// XO — five fixed 1v1 tables. Shared by the Worker (XoRoom routes) and the browser client.
export const XO_ROOM_CODES = Object.freeze(['XO01', 'XO02', 'XO03', 'XO04', 'XO05']);

export function xoGamePath() {
  return '/xo';
}

export function xoRoomUrl(code) {
  return `${xoGamePath()}/?room=${String(code).toUpperCase()}`;
}

export function xoTableLabel(index) {
  return `Bàn ${String(index + 1).padStart(2, '0')}`;
}

export function isXoRoomCode(value) {
  return XO_ROOM_CODES.includes(String(value).toUpperCase());
}
