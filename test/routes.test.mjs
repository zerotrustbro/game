import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_CODES, gamePath, parseRoute, roomPath } from '../tienlen/public/routes.js';

test('builds a fixed-table room path', () => {
  assert.equal(roomPath('ban01'), '/tienlen/room/BAN01');
});

test('exposes five fixed tables for the Tiến Lên lobby', () => {
  assert.deepEqual(ROOM_CODES, ['BAN01', 'BAN02', 'BAN03', 'BAN04', 'BAN05']);
});

test('parses ecosystem, game lobby, and room routes', () => {
  assert.deepEqual(parseRoute('/'), { page: 'hub', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen'), { page: 'tienlen', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen/'), { page: 'tienlen', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen/room/BAN01'), { page: 'tienlen', roomCode: 'BAN01' });
  assert.deepEqual(parseRoute('/tienlen/room/ban01'), { page: 'tienlen', roomCode: 'BAN01' });
});

test('rejects malformed room routes without changing the game lobby path', () => {
  assert.deepEqual(parseRoute('/tienlen/room/A'), { page: 'not-found', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen/room/ABC123'), { page: 'not-found', roomCode: null });
  assert.deepEqual(parseRoute('/tienlen/room/ABC-123'), { page: 'not-found', roomCode: null });
  assert.equal(gamePath(), '/tienlen');
});
