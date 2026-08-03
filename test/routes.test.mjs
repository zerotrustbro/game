import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_CODES, gamePath, parseRoute, roomPath } from '../tienlen/public/routes.js';

test('builds a shareable room path', () => {
  assert.equal(roomPath('abc123'), '/tienlen/room/ABC123');
});

test('exposes five fixed tables for the Tiến Lên lobby', () => {
  assert.deepEqual(ROOM_CODES, ['BAN01', 'BAN02', 'BAN03', 'BAN04', 'BAN05']);
});

test('parses ecosystem, game lobby, and room routes', () => {
  assert.deepEqual(parseRoute('/'), { page: 'hub', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen'), { page: 'tienlen', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen/'), { page: 'tienlen', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen/room/ABC123'), { page: 'tienlen', roomCode: 'ABC123' });
  assert.deepEqual(parseRoute('/tienlen/room/abc123'), { page: 'tienlen', roomCode: 'ABC123' });
});

test('rejects malformed room routes without changing the game lobby path', () => {
  assert.deepEqual(parseRoute('/tienlen/room/A'), { page: 'not-found', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen/room/ABC-123'), { page: 'not-found', roomCode: null });
  assert.equal(gamePath(), '/tienlen');
});
