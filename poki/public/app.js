import { GEM_LABEL, MONSTERS } from './game.js';
import { attackSound, creatureVoice, defeatSound, rewardSound, setSoundEnabled, soundEnabled, unlockAudio } from './audio.js';
import { POKI_ROOM_CODES, isPokiRoomCode, pokiGamePath, pokiRoomUrl, pokiTableLabel } from './routes.js';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');

let conn; // { ws, id, monster, code }
let state; // battle state broadcast by the server
let tables = [];
let selectedTable = '';
let tablesLoading = false;
let selected;
let notice = '';
let effect = '';
let preview = 'emberfox';
let lastActionKey = '';
let lastResultKey = '';
let receivedRoomState = false;
let displayedBoard;
let boardAnimationToken = 0;
let effectToken = 0;

let id = localStorage.getItem('player-id') || crypto.randomUUID();
localStorage.setItem('player-id', id);
const monsterIds = Object.keys(MONSTERS);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const art = (mid, alt = MONSTERS[mid].name) => `<img src="/poki/creatures/${mid}.webp" alt="${esc(alt)}">`;
const normalizeRoom = (value) => String(value || '').trim().toUpperCase();

function nickname() {
  return (localStorage.getItem('game-nick') || '').trim().slice(0, 18) || 'Người chơi';
}

function skillSummary(mid) {
  const s = MONSTERS[mid].skill;
  return `${s.damage} sát thương${s.healing ? ` · +${s.healing} HP` : ''}${s.manaDrain ? ` · −${s.manaDrain} Mana` : ''}${s.selfDamage ? ` · phản lực ${s.selfDamage}` : ''}${s.shield ? ` · khiên ${s.shield}` : ''}`;
}

function showToast(message, tone = '') {
  toast.textContent = message;
  toast.className = `toast visible ${tone}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function tableRow(table, index) {
  const players = Math.max(0, Number(table.players) || 0);
  const full = players >= 2;
  const joinable = Boolean(table.canJoin);
  const locked = !joinable;
  const status = table.phase === 'unavailable'
    ? 'TẠM LỖI'
    : table.gameOver
      ? (full ? 'KẾT THÚC' : 'KẾT THÚC · CÒN CHỖ')
      : full ? 'ĐANG ĐẤU' : players === 1 ? 'CHỜ ĐỐI THỦ' : 'CÒN CHỖ';
  const isSelected = selectedTable === table.code;
  return `<button class="table-row ${isSelected ? 'selected' : ''} ${locked ? 'locked' : ''}" type="button" data-table="${esc(table.code)}" ${locked ? 'disabled' : ''}><span class="table-code">${esc(table.code)}</span><span class="table-copy"><b>${pokiTableLabel(index)}</b><small>${players}/2 người · ${status}</small></span><span class="table-status">${status}</span></button>`;
}

function renderTables() {
  const list = document.querySelector('#tableList');
  if (!list) return;
  if (!tables.length) {
    list.innerHTML = '<p class="table-loading">Đang tải danh sách bàn…</p>';
    return;
  }
  if (selectedTable && !tables.find((table) => table.code === selectedTable && table.canJoin)) {
    selectedTable = tables.find((table) => table.code === selectedTable && table.canJoin)?.code || '';
  }
  list.innerHTML = tables.map(tableRow).join('');
  list.querySelectorAll('[data-table]').forEach((button) => {
    button.onclick = () => { selectedTable = button.dataset.table; renderTables(); };
  });
}

async function loadTables() {
  if (tablesLoading) return;
  tablesLoading = true;
  try {
    const response = await fetch(`/api/poki/rooms?pid=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('table list unavailable');
    const data = await response.json();
    tables = Array.isArray(data.rooms) ? data.rooms : [];
  } catch {
    tables = [];
  } finally {
    tablesLoading = false;
  }
}

function renderLobby() {
  const requested = normalizeRoom(new URLSearchParams(location.search).get('room') || '');
  if (isPokiRoomCode(requested)) selectedTable = requested;
  const monster = MONSTERS[preview];
  const savedNick = localStorage.getItem('game-nick') || '';
  app.innerHTML = `<main class="select-screen">
    <div class="select-top"><a class="hub-link" href="/">← GAME ROOM</a><div class="brand">POKI <i>DUEL</i></div><div class="select-meta">ORIGINAL CREATURE BATTLE <b>${monsterIds.length} / ${monsterIds.length}</b><button class="sound-toggle" id="sound" aria-label="Bật hoặc tắt âm thanh">${soundEnabled() ? '🔊 ÂM THANH' : '🔇 TẮT ÂM'}</button></div></div>
    <section class="select-layout">
      <nav class="roster"><p class="eyebrow">CHỌN CHIẾN BINH</p>${monsterIds.map((mid) => {
        const m = MONSTERS[mid];
        return `<button class="roster-item ${mid === preview ? 'active' : ''}" data-monster="${mid}"><span>${art(mid)}</span><b>${m.name}</b><small>${m.skill.name}</small></button>`;
      }).join('')}</nav>
      <section class="showcase monster-${preview}"><div class="showcase-backdrop"></div><div class="creature-large">${art(preview)}</div><div class="creature-plaque"><span>POKI CREATURE / 0${monsterIds.indexOf(preview) + 1}</span><h1>${MONSTERS[preview].name}</h1><p>${skillSummary(preview)}</p></div></section>
      <aside class="loadout"><p class="eyebrow">HỒ SƠ CHIẾN ĐẤU</p><h2>${monster.skill.name}</h2><p class="loadout-copy">Một chiến binh nguyên bản với nhịp chơi riêng. Ghép Kiếm để tấn công, Tim để hồi HP, Mana để mở tuyệt kỹ.</p><div class="stat"><span>SỨC MẠNH TUYỆT KỸ</span><b>${monster.skill.damage}</b></div><div class="stat"><span>HP KHỞI ĐẦU</span><b>${monster.maxHp}</b></div><div class="stat"><span>MANA KHỞI ĐẦU</span><b>0</b></div><div class="loadout-rule"><i>⚔</i><span>Ghép 3 gem cùng loại<br><small>Không có kỹ năng chủ động trước khi đủ 100 Mana.</small></span></div>
      <div class="nick-area"><span class="mini-label">BIỆT DANH</span><input id="nick" class="nick-input" maxlength="18" placeholder="Tên hiển thị của bạn" autocomplete="nickname" value="${esc(savedNick)}" /></div>
      <p class="eyebrow tables-eyebrow">CHỌN BÀN · 1VS1 · ${POKI_ROOM_CODES.length} BÀN</p>
      <div class="table-list" id="tableList"></div>
      <button class="enter" id="enter">VÀO TRẬN VỚI ${monster.name.toUpperCase()} <span>→</span></button></aside>
    </section><footer><span>HP RIÊNG TỪNG POKI</span><span>•</span><span>MANA 0 → 100</span><span>•</span><span>3 GEM BATTLE SYSTEM</span></footer>
  </main>`;
  renderTables();
  document.querySelectorAll('.roster-item').forEach((button) => {
    button.onclick = () => { preview = button.dataset.monster; creatureVoice(preview); renderLobby(); };
  });
  document.querySelector('#sound').onclick = () => { setSoundEnabled(!soundEnabled()); renderLobby(); };
  document.querySelector('#nick').addEventListener('input', (event) => {
    localStorage.setItem('game-nick', event.target.value.trim().slice(0, 18));
  });
  document.querySelector('#enter').addEventListener('click', enterTable);
}

function enterTable() {
  unlockAudio();
  if (!selectedTable) return showToast('Hãy chọn một bàn để vào trận.', 'error');
  connect(selectedTable, preview);
}

function connect(code, monster) {
  conn = { ws: null, id, monster, code };
  receivedRoomState = false;
  lastActionKey = '';
  lastResultKey = '';
  displayedBoard = undefined;
  boardAnimationToken++;
  history.replaceState({}, '', pokiRoomUrl(code));
  app.innerHTML = `<main class="connecting"><div class="brand">POKI <i>DUEL</i></div><div class="loader"></div><p>ĐANG MỞ ĐẤU TRƯỜNG…</p></main>`;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/poki/room/${code}`);
  conn.ws = ws;
  ws.onopen = () => {
    if (conn?.ws !== ws) return;
    ws.send(JSON.stringify({ type: 'join', id, name: nickname(), monster }));
  };
  ws.onmessage = (event) => {
    if (conn?.ws !== ws) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'error') {
      notice = message.message;
      selected = undefined;
      if (message.fatal) {
        showToast(message.message, 'error');
        state = undefined;
        conn?.ws?.close();
        conn = undefined;
        history.replaceState({}, '', pokiGamePath());
        loadTables().then(renderLobby);
        return;
      }
      if (state) { render(); return; }
      showToast(message.message, 'error');
      state = undefined;
      conn = undefined;
      loadTables().then(renderLobby);
      return;
    }
    if (message.type !== 'state') return;
    conn.id = message.you;
    // Persist the server's canonical id so reconnects and room-list queries
    // use the same identity instead of a legacy id that gets remapped again.
    if (id !== message.you) {
      id = message.you;
      localStorage.setItem('player-id', id);
    }
    state = message.battle;
    notice = '';
    if (!receivedRoomState) { receivedRoomState = true; render(); return; }
    playEffect();
  };
  ws.onerror = () => undefined;
  ws.onclose = () => {
    if (conn?.ws !== ws) return;
    if (state) setTimeout(() => { if (conn?.ws === ws) connect(code, monster); }, 1600);
    else { conn = undefined; loadTables().then(renderLobby); }
  };
}

function fighter(player, mine) {
  if (!player) return `<aside class="fighter waiting"><div class="waiting-mark">+</div><b>ĐANG CHỜ ĐỐI THỦ</b><small>Gửi link bàn để bắt đầu trận đấu</small></aside>`;
  const monster = MONSTERS[player.monster];
  const maxHp = monster.maxHp;
  const hp = state.hp[player.id] ?? maxHp;
  const mana = state.mana[player.id] ?? 0;
  const shield = state.shield[player.id] ?? 0;
  return `<aside class="fighter ${mine ? 'mine' : 'opponent'} monster-${player.monster}"><div class="fighter-label"><span>${mine ? 'BẠN' : 'ĐỐI THỦ'}</span><i>${esc(player.name || (mine ? 'Bạn' : 'Đối thủ'))}</i></div><div class="fighter-art">${art(player.monster)}</div><div class="fighter-name"><h2>${monster.name}</h2><small>${monster.skill.name}</small></div><div class="meter-row"><span>HP</span><b>${hp}<em>/ ${maxHp}</em></b></div><div class="meter hp"><i style="width:${hp / maxHp * 100}%"></i></div><div class="meter-row mana-label"><span>MANA</span><b>${mana}<em>/ 100</em></b></div><div class="meter mana"><i style="width:${mana}%"></i></div>${shield ? `<div class="shield">⬡ SHIELD ${shield}</div>` : ''}${mine ? `<button class="special" id="special" ${mana < 100 || displayedBoard ? 'disabled' : ''}><span>✦</span><b>${monster.skill.name.toUpperCase()}</b><small>${displayedBoard ? 'ĐANG HIỂN THỊ COMBO' : mana < 100 ? 'CẦN ĐỦ 100 MANA' : `${skillSummary(player.monster)} · KẾT THÚC LƯỢT`}</small></button>` : ''}</aside>`;
}

function render() {
  if (!state || !conn) return;
  const me = state.players.find((p) => p.id === conn.id);
  const foe = state.players.find((p) => p.id !== conn.id);
  const ready = state.players.length === 2;
  const active = state.players[state.turn % Math.max(1, state.players.length)];
  // A disconnected opponent's turn belongs to the player who is still here.
  const mine = active ? active.id === conn.id || (active.connected === false && Boolean(me)) : false;
  const board = displayedBoard ?? state.board;
  const action = notice || (state.gameOver ? 'TRẬN ĐẤU ĐÃ KẾT THÚC' : !ready ? 'GỬI LINK BÀN CHO NGƯỜI THỨ HAI' : effect || (mine ? 'LƯỢT CỦA BẠN · CHỌN HAI GEM KỀ NHAU' : 'ĐỐI THỦ ĐANG TÍNH NƯỚC ĐI'));
  const result = state.gameOver ? `<div class="result-screen"><div class="result-box"><p>${state.winner === conn.id ? 'VICTORY' : 'DEFEAT'}</p><h1>${state.winner === conn.id ? 'BẠN ĐÃ CHIẾN THẮNG' : 'POKI THÚ CỦA BẠN ĐÃ GỤC NGÃ'}</h1><span>${state.winner === conn.id ? 'Đối thủ đã về 0 HP.' : 'HP của bạn đã về 0.'}</span><button id="new-match">ĐẤU LẠI VỚI ĐỐI THỦ →</button><button class="result-leave" id="result-leave">RỜI BÀN</button></div></div>` : '';
  app.innerHTML = `<main class="arena monster-${conn.monster} ${state.gameOver ? 'match-ended' : ''}"><header class="arena-header"><div class="brand"><a class="hub-link" href="/">← GAME ROOM</a>POKI <i>DUEL</i></div><div class="room-chip">BÀN <b>${esc(conn.code)}</b></div><div class="arena-actions"><button class="sound-toggle" id="sound" aria-label="Bật hoặc tắt âm thanh">${soundEnabled() ? '🔊' : '🔇'}</button><button class="copy" id="copy">COPY INVITE LINK</button><button class="leave" id="leave">RỜI BÀN</button></div></header><section class="battle-stage"><div class="stage-grid"></div><div class="stage-light"></div>${fighter(me, true)}<section class="board-zone"><div class="turn-banner ${mine ? 'your-turn' : ''}"><span>${mine ? 'YOUR TURN' : 'OPPONENT TURN'}</span><b>${action}</b></div><div class="board ${mine && ready && !displayedBoard ? 'playable' : ''}">${board.map((row, y) => row.map((gem, x) => `<button class="gem ${gem} ${selected?.x === x && selected?.y === y ? 'selected' : ''}" data-x="${x}" data-y="${y}"><span>${GEM_LABEL[gem]}</span></button>`).join('')).join('')}</div><div class="legend"><span class="sword">⚔ <b>SWORD</b><small>ATTACK</small></span><span class="heart">♥ <b>HEART</b><small>HEAL</small></span><span class="mana">✦ <b>MANA</b><small>CHARGE</small></span></div></section>${fighter(foe, false)}</section>${state.lastAction?.special ? '<div class="ultimate-flash">✦ ULTIMATE ✦</div>' : ''}<div class="battle-fx ${effect.includes('SWORD') ? 'sword-fx' : ''} ${effect.includes('HEAL') ? 'heal-fx' : ''} ${effect.includes('MANA') ? 'mana-fx' : ''}">${effect.includes('SWORD') ? '⚔' : effect.includes('HEAL') ? '+♥' : effect.includes('MANA') ? '+✦' : ''}</div>${result}</main>`;
  document.querySelector('#copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showToast('Đã copy link mời.');
    } catch {
      showToast('Không thể copy link trên trình duyệt này.', 'error');
    }
  });
  document.querySelector('#sound')?.addEventListener('click', () => { setSoundEnabled(!soundEnabled()); render(); });
  document.querySelector('#special')?.addEventListener('click', () => { unlockAudio(); send({ type: 'special' }); });
  document.querySelector('#new-match')?.addEventListener('click', () => { unlockAudio(); send({ type: 'restart' }); });
  document.querySelector('#result-leave')?.addEventListener('click', leaveTable);
  document.querySelector('#leave')?.addEventListener('click', leaveTable);
  document.querySelectorAll('.gem').forEach((button) => { button.onclick = () => move({ x: Number(button.dataset.x), y: Number(button.dataset.y) }); });
}

function send(message) {
  if (conn?.ws?.readyState !== WebSocket.OPEN) {
    showToast('Kết nối chưa sẵn sàng.', 'error');
    return false;
  }
  conn.ws.send(JSON.stringify(message));
  return true;
}

function leaveTable() {
  if (conn?.ws?.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ type: 'leave' }));
  state = undefined;
  conn?.ws?.close();
  conn = undefined;
  history.replaceState({}, '', pokiGamePath());
  loadTables().then(renderLobby);
}

function move(point) {
  unlockAudio();
  if (!state || !conn) return;
  const active = state.players[state.turn % Math.max(1, state.players.length)];
  const myTurn = active?.id === conn.id || (active?.connected === false && state.players.some((p) => p.id === conn.id));
  if (displayedBoard || state.players.length !== 2 || !myTurn) return;
  if (!selected) { selected = point; render(); return; }
  if (Math.abs(selected.x - point.x) + Math.abs(selected.y - point.y) !== 1) { selected = point; render(); return; }
  if (!send({ type: 'move', from: selected, to: point })) return;
  selected = undefined;
  notice = 'ĐANG XỬ LÝ COMBO…';
  render();
}

function playEffect() {
  const action = state?.lastAction;
  if (!action) { effect = ''; render(); return; }
  // Replays of the same last action (reconnect/refresh broadcasts) must not
  // re-run sounds, board animation or the effect banner.
  const actionKey = `${state.turn}:${action.player}:${action.special ? 'special' : 'move'}:${action.damage}:${action.healing}:${action.mana}:${action.cleared}`;
  if (actionKey === lastActionKey) return;
  lastActionKey = actionKey;
  const currentEffectToken = ++effectToken;
  const animationToken = ++boardAnimationToken;
  const frames = action.frames ?? [];
  displayedBoard = frames[0]?.board;
  if (frames.length) {
    frames.slice(1).forEach((frame, index) => window.setTimeout(() => {
      if (animationToken !== boardAnimationToken) return;
      displayedBoard = frame.board;
      render();
    }, (index + 1) * 240));
    window.setTimeout(() => {
      if (animationToken !== boardAnimationToken) return;
      displayedBoard = undefined;
      render();
    }, frames.length * 240);
  }
  const attacker = state.players.find((player) => player.id === action.player);
  if (attacker && (action.special || action.damage)) attackSound(attacker.monster, Boolean(action.special));
  else if (action.healing) rewardSound('heal');
  else if (action.mana) rewardSound('mana');
  if (state?.gameOver) {
    const resultKey = `${state.winner}:${state.loser}`;
    if (resultKey !== lastResultKey) { lastResultKey = resultKey; defeatSound(state.winner === conn.id); }
  }
  const combo = action.cascades > 1 ? ` · COMBO x${action.cascades} · ${action.cleared} GEM` : '';
  effect = action.special ? `✦ ${action.skillName?.toUpperCase()} · ${action.damage} DAMAGE` : action.damage ? `SWORD · ${action.damage} DAMAGE${combo}` : action.healing ? `HEAL · +${action.healing} HP${combo}` : action.mana ? `MANA · +${action.mana}${combo}` : combo.trim();
  render();
  window.setTimeout(() => {
    if (currentEffectToken !== effectToken) return;
    effect = '';
    render();
  }, 1500);
}

// ---- Boot ----
(async function boot() {
  await loadTables();
  renderLobby();
  setInterval(async () => {
    if (!document.querySelector('#tableList')) return;
    if (document.querySelector('#app .select-screen')) {
      await loadTables();
      renderTables();
    }
  }, 5000);
})();
