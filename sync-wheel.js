import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js';
import { getDatabase, ref, onValue, get, set, update, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js';

const SHEET_ID = '17phnEn-NW-OnrZg4DcW65r-Xoq6ScsdVjS5yL0SS3fk';
const INPUT_SHEET_GID = '703438953'; // аркуш 33
const WRITER_URL = 'https://script.google.com/macros/s/AKfycby3U55n5334RbGZyrXp1vHN-rMkqOE7A8txmPh8N8vt26Fb6tAqya6Gb2BTCokgwIpM2w/exec';
const ROOM_ID = sanitizeRoom(new URLSearchParams(location.search).get('room') || 'main');
const IS_CONTROL = new URLSearchParams(location.search).get('view') === 'control' || /control\.html$/i.test(location.pathname);
const columns = { ROUND_1: 3, ROUND_2: 4, ROUND_3: 5, FINAL: 6 };
const ROUND_SOURCES = ['ROUND_1', 'ROUND_2', 'ROUND_3'];
const TAU = Math.PI * 2;
const $ = id => document.getElementById(id);
const canvas = $('wheel');
const ctx = canvas.getContext('2d');

let db;
let auth;
let roomRef;
let stateRef;
let spinRef;
let platoonsRef;
let rotation = 0;
let spinning = false;
let flushing = false;
let firebaseReady = false;
let connected = false;
let serverTimeOffset = 0;
let currentSpinId = '';
let finalizedSpinIds = new Set();
let state = freshState();
let sheetLists = { ROUND_1: [], ROUND_2: [], ROUND_3: [], FINAL: [] };
let sheetDefaultSource = 'ROUND_1';
let pendingWrites = loadPendingWrites();
let persistentPlatoons = emptyPlatoonsByRound();

document.body.classList.toggle('obs', !IS_CONTROL);
document.body.classList.toggle('control', IS_CONTROL);
$('roomName').textContent = ROOM_ID;
$('controllerUidBox').style.display = IS_CONTROL ? 'block' : 'none';
$('controlHint').style.display = IS_CONTROL ? 'block' : 'none';

function emptyPlatoonsByRound() {
  return { ROUND_1: [], ROUND_2: [], ROUND_3: [] };
}

function emptySourceStates() {
  return {
    ROUND_1: { all: [], remaining: [], selected: [], rotation: 0, finalWinnerQueued: '' },
    ROUND_2: { all: [], remaining: [], selected: [], rotation: 0, finalWinnerQueued: '' },
    ROUND_3: { all: [], remaining: [], selected: [], rotation: 0, finalWinnerQueued: '' },
    FINAL:   { all: [], remaining: [], selected: [], rotation: 0, finalWinnerQueued: '' },
  };
}

function freshState() {
  return {
    version: 5,
    source: 'ROUND_1',
    mode: 'PLATOON',
    all: [],
    remaining: [],
    selected: [],
    log: [],
    platoonsByRound: emptyPlatoonsByRound(),
    sourceStates: emptySourceStates(),
    finalWinnerQueued: '',
    rotation: 0,
  };
}

function sanitizeRoom(value) {
  const safe = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return safe || 'main';
}

function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function random01() {
  if (window.crypto && window.crypto.getRandomValues) {
    const value = new Uint32Array(1);
    window.crypto.getRandomValues(value);
    return value[0] / 4294967296;
  }
  return Math.random();
}

function randomInt(maxExclusive) {
  return Math.floor(random01() * maxExclusive);
}

function nowServer() {
  return Date.now() + serverTimeOffset;
}

function configLooksReady(config) {
  return config && typeof config === 'object' &&
    String(config.apiKey || '').trim() &&
    String(config.projectId || '').trim() &&
    String(config.databaseURL || '').trim() &&
    !String(config.apiKey).includes('PASTE_') &&
    !String(config.databaseURL).includes('PASTE_');
}

function normalizePlatoon(value) {
  return Array.isArray(value) ? value.map(String).map(x => x.trim()).filter(Boolean).slice(0, 3) : [];
}

function normalizePlatoonsByRound(value, safeState = {}) {
  const result = emptyPlatoonsByRound();
  const raw = value && typeof value === 'object' ? value : {};
  for (const source of ROUND_SOURCES) {
    result[source] = Array.isArray(raw[source])
      ? raw[source].map(normalizePlatoon).filter(players => players.length)
      : [];
  }
  // Сумісність із попередньою версією: відновлюємо вже сформовані тестові взводи з журналу.
  const source = ROUND_SOURCES.includes(String(safeState.source || '')) ? String(safeState.source) : 'ROUND_1';
  if (!result[source].length && Array.isArray(safeState.log)) {
    for (const row of safeState.log) {
      const text = String(row || '');
      const prefix = '👥 Взвод сформовано:';
      if (!text.startsWith(prefix)) continue;
      const players = text.slice(prefix.length).split('•').map(x => x.trim()).filter(Boolean).slice(0, 3);
      if (players.length) result[source].push(players);
    }
  }
  return result;
}

function platoonSignature(players) {
  return normalizePlatoon(players).map(name => name.toLowerCase()).join('\u0001');
}

function mergePlatoonsByRound(...maps) {
  const result = emptyPlatoonsByRound();
  for (const source of ROUND_SOURCES) {
    const seen = new Set();
    for (const map of maps) {
      const raw = map && typeof map === 'object' ? map[source] : [];
      const list = Array.isArray(raw) ? raw : [];
      for (const playersRaw of list) {
        const players = normalizePlatoon(playersRaw);
        if (!players.length) continue;
        const key = platoonSignature(players);
        if (seen.has(key)) continue;
        seen.add(key);
        result[source].push(players);
      }
    }
  }
  return result;
}

function hasAnyPlatoons(map) {
  return ROUND_SOURCES.some(source => Array.isArray(map?.[source]) && map[source].length);
}

function applyPersistentPlatoons(target = state) {
  target.platoonsByRound = mergePlatoonsByRound(persistentPlatoons, target.platoonsByRound);
  return target;
}

async function persistPlatoonsBoard() {
  persistentPlatoons = mergePlatoonsByRound(state.platoonsByRound);
  state.platoonsByRound = mergePlatoonsByRound(persistentPlatoons);
  if (platoonsRef) await set(platoonsRef, persistentPlatoons);
}

function normalizeNames(value) {
  return Array.isArray(value) ? value.map(String).map(x => x.trim()).filter(Boolean) : [];
}

function normalizeSourceState(value) {
  const safe = value && typeof value === 'object' ? value : {};
  return {
    all: normalizeNames(safe.all),
    remaining: normalizeNames(safe.remaining),
    selected: normalizeNames(safe.selected),
    rotation: Number.isFinite(Number(safe.rotation)) ? Number(safe.rotation) : 0,
    finalWinnerQueued: String(safe.finalWinnerQueued || ''),
  };
}

function normalizeSourceStates(value, safeState = {}) {
  const result = emptySourceStates();
  const raw = value && typeof value === 'object' ? value : {};
  for (const source of [...ROUND_SOURCES, 'FINAL']) result[source] = normalizeSourceState(raw[source]);
  const active = columns[String(safeState.source || '')] !== undefined ? String(safeState.source) : 'ROUND_1';
  if (!result[active].all.length && Array.isArray(safeState.all)) {
    result[active] = normalizeSourceState({
      all: safeState.all,
      remaining: safeState.remaining,
      selected: safeState.selected,
      rotation: safeState.rotation,
      finalWinnerQueued: safeState.finalWinnerQueued,
    });
  }
  return result;
}

function sameNames(a, b) {
  const left = normalizeNames(a);
  const right = normalizeNames(b);
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function saveActiveSnapshot(target = state) {
  if (!target || columns[target.source] === undefined) return target;
  target.sourceStates = normalizeSourceStates(target.sourceStates, target);
  target.sourceStates[target.source] = normalizeSourceState({
    all: target.all,
    remaining: target.remaining,
    selected: target.selected,
    rotation: target.rotation,
    finalWinnerQueued: target.finalWinnerQueued,
  });
  return target;
}

function ensureStateShape(value) {
  const base = freshState();
  const safe = value && typeof value === 'object' ? value : {};
  const shaped = {
    ...base,
    ...safe,
    version: 5,
    all: normalizeNames(safe.all),
    remaining: normalizeNames(safe.remaining),
    selected: normalizeNames(safe.selected),
    log: Array.isArray(safe.log) ? safe.log.map(String) : [],
    platoonsByRound: normalizePlatoonsByRound(safe.platoonsByRound, safe),
    sourceStates: normalizeSourceStates(safe.sourceStates, safe),
    rotation: Number.isFinite(Number(safe.rotation)) ? Number(safe.rotation) : 0,
  };
  return saveActiveSnapshot(shaped);
}

function publicState() {
  applyPersistentPlatoons(state);
  saveActiveSnapshot(state);
  return {
    ...ensureStateShape(state),
    updatedAt: serverTimestamp(),
  };
}

function loadPendingWrites() {
  try {
    const value = JSON.parse(localStorage.getItem('wot_platoon_pending_writes_v3') || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function savePendingWrites() {
  localStorage.setItem('wot_platoon_pending_writes_v3', JSON.stringify(pendingWrites));
}

function getWriterUrl() {
  return WRITER_URL;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[m]));
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.className = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : 'muted';
  el.textContent = text;
}

function setSyncStatus(text, kind = '') {
  const el = $('syncStatus');
  el.className = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : 'muted';
  el.textContent = text;
}

function palette(i) {
  const colors = ['#ff8a00', '#40e0d0', '#5d8cff', '#70e000', '#d36cff', '#ff5d73', '#ffd166', '#00b4d8'];
  return colors[i % colors.length];
}

function drawWheel() {
  const items = state.remaining;
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = 390;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  if (!items.length) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fillStyle = '#152737';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,138,0,.7)';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '900 38px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(firebaseReady ? 'СПИСОК ПОРОЖНІЙ' : 'ПІДКЛЮЧЕННЯ…', 0, 10);
    ctx.restore();
    return;
  }
  const slice = TAU / items.length;
  items.forEach((name, i) => {
    const a0 = i * slice;
    const a1 = a0 + slice;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = palette(i);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.34)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.save();
    ctx.rotate(a0 + slice / 2);
    ctx.translate(r * .24, 0);
    ctx.fillStyle = '#071018';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${items.length > 28 ? 16 : items.length > 18 ? 20 : items.length > 10 ? 24 : 30}px Arial`;
    const maxLength = items.length > 28 ? 20 : items.length > 18 ? 18 : items.length > 10 ? 16 : 14;
    const short = name.length > maxLength ? name.slice(0, maxLength - 1) + '…' : name;
    ctx.fillText(short, 0, 0);
    ctx.restore();
  });
  ctx.beginPath();
  ctx.arc(0, 0, 76, 0, TAU);
  ctx.fillStyle = '#071018';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = '#ff8a00';
  ctx.font = '1000 29px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('WoT', 0, 10);
  ctx.restore();
}

function roundTitle(source) {
  return ({ ROUND_1: 'ТУР 1', ROUND_2: 'ТУР 2', ROUND_3: 'ТУР 3' })[source] || source;
}

function renderPlatoonsBoard() {
  const board = $('platoonsBoard');
  if (!board) return;
  const groups = ROUND_SOURCES.map(source => {
    const platoons = state.platoonsByRound?.[source] || [];
    const isActive = state.mode === 'PLATOON' && state.source === source;
    const forming = isActive && state.selected.length ? state.selected : [];
    const rows = platoons.map((players, index) => `
      <div class="platoon-row">
        <div class="platoon-number">Взвод ${index + 1}</div>
        <div class="platoon-members">${players.map(escapeHtml).join(' • ')}</div>
      </div>`).join('');
    const formingRow = forming.length ? `
      <div class="platoon-row forming">
        <div class="platoon-number">Взвод ${platoons.length + 1}</div>
        <div class="platoon-members">Формується: ${forming.map(escapeHtml).join(' • ')}${forming.length < 3 ? ' • …' : ''}</div>
      </div>` : '';
    const empty = !rows && !formingRow ? '<div class="empty-round">Ще немає сформованих взводів</div>' : '';
    return `
      <div class="round-block${isActive ? ' active' : ''}">
        <div class="round-head">
          <div class="round-name">${roundTitle(source)}</div>
          <div class="round-count">${platoons.length} взводів</div>
        </div>
        <div class="platoon-list">${rows}${formingRow}${empty}</div>
      </div>`;
  });
  board.innerHTML = groups.join('');
}

function render() {
  $('activeList').textContent = state.source === 'FINAL' ? 'ФІНАЛ' : roundTitle(state.source);
  $('sourceRound1').classList.toggle('active', state.source === 'ROUND_1');
  $('sourceRound2').classList.toggle('active', state.source === 'ROUND_2');
  $('sourceRound3').classList.toggle('active', state.source === 'ROUND_3');
  $('sourceFinal').classList.toggle('active', state.source === 'FINAL');
  $('subtitle').textContent = state.mode === 'FINAL'
    ? 'Фінальне колесо: викреслюємо гравців, доки не залишиться один'
    : 'Формуємо нові взводи по три гравці';
  $('remainingCount').textContent = state.remaining.length;
  $('pickedCount').textContent = state.selected.length;
  $('platoonMode').classList.toggle('active', state.mode === 'PLATOON');
  $('finalMode').classList.toggle('active', state.mode === 'FINAL');
  $('pickedTitle').textContent = state.mode === 'FINAL' ? 'Останній вибутий гравець' : 'Поточний взвод';
  $('pickedSlots').innerHTML = '';
  $('winnerBox').style.display = 'none';
  if (state.mode === 'PLATOON') {
    for (let i = 0; i < 3; i += 1) {
      const d = document.createElement('div');
      d.className = 'slot' + (state.selected[i] ? ' filled' : '');
      d.textContent = state.selected[i] || `${i + 1}. очікує вибору`;
      $('pickedSlots').appendChild(d);
    }
  } else {
    const d = document.createElement('div');
    d.className = 'slot' + (state.selected.length ? ' filled' : '');
    d.textContent = state.selected.at(-1) || 'Ще нікого не викреслено';
    $('pickedSlots').appendChild(d);
    if (state.remaining.length === 1) {
      $('winnerName').textContent = state.remaining[0];
      $('winnerBox').style.display = 'block';
    }
  }
  renderPlatoonsBoard();
  const publicLog = state.log.filter(x => !String(x).startsWith('📝 Записано') && !String(x).includes('аркуш 44'));
  $('log').innerHTML = publicLog.length
    ? publicLog.slice().reverse().map(x => `<div class="log-row">${escapeHtml(x)}</div>`).join('')
    : '<div class="muted">Ще немає вибраних гравців</div>';
  const noControl = !IS_CONTROL || !firebaseReady || !connected;
  $('spinBtn').disabled = noControl || spinning || !state.remaining.length || (state.mode === 'PLATOON' && state.selected.length >= 3) || (state.mode === 'FINAL' && state.remaining.length <= 1);
  $('nextPlatoonBtn').disabled = noControl || state.mode !== 'PLATOON' || spinning || state.selected.length !== 3;
  $('undoBtn').disabled = noControl || spinning || !state.selected.length;
  $('reloadBtn').disabled = noControl || spinning;
  $('resetBtn').disabled = noControl || spinning;
  drawWheel();
  renderWriterStatus();
}

function cellValue(cell) {
  return cell ? (cell.v ?? cell.f ?? '') : '';
}

function rowsToGrid(data) {
  return (data.table.rows || []).map(row => (row.c || []).map(cellValue));
}

function setting(grid, name, fallback = '') {
  for (const row of grid) {
    if (String(row[0] ?? '').trim().toUpperCase() === name.toUpperCase()) return row[1] ?? fallback;
  }
  return fallback;
}

function uniqueNames(grid, col) {
  const seen = new Set();
  const names = [];
  for (let r = 0; r < grid.length; r += 1) {
    const name = String(grid[r]?.[col] ?? '').trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

function loadGoogleSheetJsonp() {
  return new Promise((resolve, reject) => {
    const callbackName = `__wotPlatoonCup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      script.remove();
      try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
    };
    window[callbackName] = data => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Google Sheets недоступний. Перевір доступ: «Усі, хто має посилання» → «Читач»')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Google Sheets не відповів')); }, 12000);
    const tqx = `out:json;responseHandler:${callbackName}`;
    script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=${encodeURIComponent(tqx)}&gid=${encodeURIComponent(INPUT_SHEET_GID)}&range=${encodeURIComponent('A1:G250')}&headers=1&_=${Date.now()}`;
    document.head.appendChild(script);
  });
}

async function fetchSheetLists() {
  const grid = rowsToGrid(await loadGoogleSheetJsonp());
  const requestedSource = String(setting(grid, 'ACTIVE_LIST', 'ROUND_1')).trim().toUpperCase();
  sheetDefaultSource = columns[requestedSource] !== undefined ? requestedSource : 'ROUND_1';
  sheetLists = {
    ROUND_1: uniqueNames(grid, columns.ROUND_1),
    ROUND_2: uniqueNames(grid, columns.ROUND_2),
    ROUND_3: uniqueNames(grid, columns.ROUND_3),
    FINAL: uniqueNames(grid, columns.FINAL),
  };
}

async function loadFromSheet(force = false) {
  if (!IS_CONTROL) return;
  setStatus('Завантаження даних з Google Sheets…');
  try {
    await fetchSheetLists();
    if (!force) {
      const snap = await get(stateRef);
      if (snap.exists()) {
        state = ensureStateShape(snap.val());
        rotation = state.rotation;
        render();
        setStatus(`Поточний мережевий стан завантажено • ${new Date().toLocaleTimeString('uk-UA')}`, 'ok');
        return;
      }
    }
    const source = force && columns[state.source] !== undefined ? state.source : sheetDefaultSource;
    const all = [...(sheetLists[source] || [])];
    const mode = source === 'FINAL' ? 'FINAL' : 'PLATOON';
    const platoonsByRound = mergePlatoonsByRound(persistentPlatoons, normalizePlatoonsByRound(state.platoonsByRound, state));
    const sourceStates = normalizeSourceStates(state.sourceStates, state);
    sourceStates[source] = normalizeSourceState({ all, remaining: all, selected: [], rotation: 0, finalWinnerQueued: '' });
    state = {
      ...freshState(),
      source,
      mode,
      all,
      remaining: [...all],
      selected: [],
      log: [...(state.log || [])],
      platoonsByRound,
      sourceStates,
    };
    rotation = 0;
    await broadcastState();
    setStatus(`${roundTitle(source)}: завантажено ${all.length} гравців із відповідної колонки Google Sheets • ${new Date().toLocaleTimeString('uk-UA')}`, all.length ? 'ok' : '');
  } catch (error) {
    setStatus(`Помилка: ${error.message}`, 'error');
  }
}

async function broadcastState() {
  if (!IS_CONTROL || !firebaseReady) return;
  state.rotation = rotation;
  saveActiveSnapshot(state);
  await set(stateRef, publicState());
}

async function switchSource(source) {
  if (!IS_CONTROL || spinning || columns[source] === undefined) return;
  setStatus(`${roundTitle(source)}: оновлення списку з Google Sheets…`);
  await fetchSheetLists();
  // Перед зміною туру зберігаємо дошку взводів окремо від колеса.
  // Завдяки цьому оновлення списку гравців одного туру ніколи не стирає результати інших турів.
  applyPersistentPlatoons(state);
  await persistPlatoonsBoard();
  saveActiveSnapshot(state);
  const all = [...(sheetLists[source] || [])];
  const mode = source === 'FINAL' ? 'FINAL' : 'PLATOON';
  const platoonsByRound = mergePlatoonsByRound(persistentPlatoons, normalizePlatoonsByRound(state.platoonsByRound, state));
  const sourceStates = normalizeSourceStates(state.sourceStates, state);
  const cached = normalizeSourceState(sourceStates[source]);
  const restoreCachedProgress = sameNames(cached.all, all);
  const selectedSource = restoreCachedProgress
    ? cached
    : normalizeSourceState({ all, remaining: all, selected: [], rotation: 0, finalWinnerQueued: '' });
  sourceStates[source] = selectedSource;
  state = {
    ...freshState(),
    source,
    mode,
    all: [...selectedSource.all],
    remaining: [...selectedSource.remaining],
    selected: [...selectedSource.selected],
    rotation: selectedSource.rotation,
    finalWinnerQueued: selectedSource.finalWinnerQueued,
    log: [...(state.log || [])],
    platoonsByRound,
    sourceStates,
  };
  rotation = state.rotation;
  await set(spinRef, null);
  await broadcastState();
  setStatus(all.length
    ? `${roundTitle(source)}: показано лише ${all.length} гравців цього туру${restoreCachedProgress ? ' • прогрес відновлено' : ''}`
    : `${roundTitle(source)}: список поки порожній`, all.length ? 'ok' : '');
}

function callWriter(job) {
  return new Promise((resolve, reject) => {
    const url = getWriterUrl();
    if (!url) return reject(new Error('Не налаштовано URL Google Apps Script'));
    const callbackName = `__wotWriter_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      script.remove();
      try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
    };
    window[callbackName] = data => {
      cleanup();
      if (data && data.ok) resolve(data);
      else reject(new Error(data?.error || 'Google Apps Script повернув помилку'));
    };
    script.onerror = () => { cleanup(); reject(new Error('Не вдалося звернутися до Google Apps Script')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Google Apps Script не відповів')); }, 15000);
    const params = new URLSearchParams({ callback: callbackName, action: job.action, request_id: job.id, ...job.payload, _: String(Date.now()) });
    script.src = `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
    document.head.appendChild(script);
  });
}

function enqueueWrite(action, payload, label) {
  if (!IS_CONTROL) return;
  pendingWrites.push({ id: makeId(), action, payload, label });
  savePendingWrites();
  renderWriterStatus();
  flushPendingWrites();
}

async function flushPendingWrites() {
  if (!IS_CONTROL || flushing || !pendingWrites.length || !getWriterUrl()) {
    renderWriterStatus();
    return;
  }
  flushing = true;
  renderWriterStatus('Синхронізація з Google Sheets…');
  try {
    while (pendingWrites.length) {
      await callWriter(pendingWrites[0]);
      pendingWrites.shift();
      savePendingWrites();
    }
    renderWriterStatus('');
  } catch (error) {
    renderWriterStatus(`⚠️ Запис не виконано: ${error.message}`, true);
  } finally {
    flushing = false;
  }
}

function renderWriterStatus(message = '', isError = false) {
  const box = $('writeStatus');
  const card = $('writeStatusCard');
  if (!box || !card || !IS_CONTROL) return;
  if (isError) {
    card.classList.add('show');
    box.className = 'error';
    box.textContent = message;
    return;
  }
  if (!getWriterUrl() && pendingWrites.length) {
    card.classList.add('show');
    box.className = 'error';
    box.textContent = `⚠️ Налаштуй запис у Google Sheets • очікує відправлення: ${pendingWrites.length}`;
    return;
  }
  if (message) {
    card.classList.add('show');
    box.className = 'muted';
    box.textContent = message;
    return;
  }
  card.classList.remove('show');
  box.textContent = '';
}

async function spin() {
  if (!IS_CONTROL || spinning || !connected || !state.remaining.length) return;
  if (state.mode === 'PLATOON' && state.selected.length >= 3) return;
  if (state.mode === 'FINAL' && state.remaining.length <= 1) return;
  const count = state.remaining.length;
  const targetIndex = randomInt(count);
  const slice = TAU / count;
  const innerOffset = (random01() - 0.5) * slice * 0.58;
  const desired = -(targetIndex * slice + slice / 2 + innerOffset);
  const currentNorm = ((rotation % TAU) + TAU) % TAU;
  let delta = ((desired - currentNorm) % TAU + TAU) % TAU;
  delta += TAU * (7 + randomInt(7));
  const event = {
    id: makeId(),
    status: 'spinning',
    startedAt: nowServer() + 700,
    duration: 4300 + randomInt(2101),
    fromRotation: rotation,
    deltaRotation: delta,
    targetIndex,
    remainingCount: count,
    source: state.source,
    mode: state.mode,
  };
  await set(spinRef, event);
}

function playSpin(event) {
  if (!event || !event.id || event.status !== 'spinning') return;
  if (event.id === currentSpinId) return;
  currentSpinId = event.id;
  spinning = true;
  render();
  const from = Number(event.fromRotation) || 0;
  const delta = Number(event.deltaRotation) || 0;
  const duration = Math.max(100, Number(event.duration) || 5000);
  const startedAt = Number(event.startedAt) || nowServer();

  function frame() {
    const elapsed = nowServer() - startedAt;
    const t = Math.max(0, Math.min(1, elapsed / duration));
    const eased = 1 - Math.pow(1 - t, 4);
    rotation = from + delta * eased;
    drawWheel();
    if (t < 1) {
      requestAnimationFrame(frame);
      return;
    }
    rotation = from + delta;
    drawWheel();
    spinning = false;
    render();
    if (IS_CONTROL) finalizeSpin(event).catch(error => setStatus(`Помилка завершення обертання: ${error.message}`, 'error'));
  }
  requestAnimationFrame(frame);
}

async function finalizeSpin(event) {
  if (!IS_CONTROL || finalizedSpinIds.has(event.id)) return;
  finalizedSpinIds.add(event.id);
  const freshSnap = await get(stateRef);
  state = ensureStateShape(freshSnap.val());
  if (Number(event.remainingCount) !== state.remaining.length) {
    await update(spinRef, { status: 'ignored', finishedAt: serverTimestamp() });
    setStatus('Подію обертання пропущено: список уже змінився. Натисни колесо ще раз.', 'error');
    return;
  }
  const index = Number(event.targetIndex);
  const name = state.remaining[index];
  if (!name) {
    await update(spinRef, { status: 'ignored', finishedAt: serverTimestamp() });
    setStatus('Не вдалося визначити гравця. Натисни колесо ще раз.', 'error');
    return;
  }
  state.remaining.splice(index, 1);
  state.selected.push(name);
  state.rotation = rotation;
  if (state.mode === 'PLATOON') {
    state.log.push(`✅ До взводу додано: ${name}`);
  } else {
    state.log.push(`❌ Вибуває: ${name}`);
    enqueueWrite('save_final_event', { player: name, event: 'ВИБУВ' }, `ФІНАЛ • вибув: ${name}`);
    if (state.remaining.length === 1 && state.finalWinnerQueued !== state.remaining[0]) {
      state.finalWinnerQueued = state.remaining[0];
      enqueueWrite('save_final_event', { player: state.remaining[0], event: 'ПЕРЕМОЖЕЦЬ' }, `ФІНАЛ • переможець: ${state.remaining[0]}`);
    }
  }
  await set(stateRef, publicState());
  await update(spinRef, { status: 'finished', finalRotation: rotation, selectedPlayer: name, finishedAt: serverTimestamp() });
  setStatus(`Обрано: ${name}`, 'ok');
}

async function nextPlatoon() {
  if (!IS_CONTROL || state.mode !== 'PLATOON' || spinning || state.selected.length !== 3) return;
  const players = [...state.selected];
  if (!state.platoonsByRound || typeof state.platoonsByRound !== 'object') state.platoonsByRound = emptyPlatoonsByRound();
  if (!Array.isArray(state.platoonsByRound[state.source])) state.platoonsByRound[state.source] = [];
  state.platoonsByRound[state.source].push(players);
  state.log.push(`👥 Взвод сформовано: ${players.join(' • ')}`);
  enqueueWrite('save_platoon', { round: state.source, p1: players[0], p2: players[1], p3: players[2] }, `${state.source} • ${players.join(' • ')}`);
  state.selected = [];
  await persistPlatoonsBoard();
  await broadcastState();
}

async function undo() {
  if (!IS_CONTROL || spinning || !state.selected.length) return;
  const name = state.selected.pop();
  state.remaining.push(name);
  state.log.push(`↩️ Повернуто у колесо: ${name}`);
  if (state.mode === 'FINAL') {
    state.finalWinnerQueued = '';
    enqueueWrite('save_final_event', { player: name, event: 'ПОВЕРНУТО У КОЛЕСО' }, `ФІНАЛ • повернуто: ${name}`);
  }
  await broadcastState();
}

async function setMode(mode) {
  if (!IS_CONTROL || spinning) return;
  if (mode === 'FINAL' && state.source !== 'FINAL') {
    await switchSource('FINAL');
    return;
  }
  if (mode === 'PLATOON' && state.source === 'FINAL') {
    await switchSource(sheetDefaultSource === 'FINAL' ? 'ROUND_1' : sheetDefaultSource);
    return;
  }
  state.mode = mode;
  state.selected = [];
  state.finalWinnerQueued = '';
  state.log.push(mode === 'FINAL' ? '🏆 Увімкнено фінальне викреслювання' : '👥 Увімкнено формування взводів');
  await broadcastState();
}

async function resetState() {
  if (!IS_CONTROL || spinning) return;
  const source = state.source;
  const label = source === 'FINAL' ? 'фіналу' : roundTitle(source);
  if (!confirm(`Скинути колесо для ${label}? Поточний вибір буде очищено.${ROUND_SOURCES.includes(source) ? ' Сформовані взводи цього туру також буде видалено.' : ''}`)) return;
  const platoonsByRound = mergePlatoonsByRound(persistentPlatoons, normalizePlatoonsByRound(state.platoonsByRound, state));
  if (ROUND_SOURCES.includes(source)) platoonsByRound[source] = [];
  const sourceStates = normalizeSourceStates(state.sourceStates, state);
  sourceStates[source] = normalizeSourceState({ all: state.all, remaining: state.all, selected: [], rotation: 0, finalWinnerQueued: '' });
  state = {
    ...freshState(),
    source,
    mode: state.mode,
    all: [...state.all],
    remaining: [...state.all],
    selected: [],
    platoonsByRound,
    sourceStates,
  };
  rotation = 0;
  persistentPlatoons = mergePlatoonsByRound(platoonsByRound);
  if (platoonsRef) await set(platoonsRef, persistentPlatoons);
  await set(spinRef, null);
  await broadcastState();
  setStatus(`Стан ${label} очищено. Усі гравці знову доступні.`, 'ok');
}

function bindButtons() {
  $('spinBtn').onclick = () => spin().catch(error => setStatus(`Помилка запуску: ${error.message}`, 'error'));
  $('nextPlatoonBtn').onclick = () => nextPlatoon().catch(error => setStatus(error.message, 'error'));
  $('undoBtn').onclick = () => undo().catch(error => setStatus(error.message, 'error'));
  $('reloadBtn').onclick = () => loadFromSheet(true);
  $('resetBtn').onclick = () => resetState().catch(error => setStatus(error.message, 'error'));
  $('platoonMode').onclick = () => setMode('PLATOON').catch(error => setStatus(error.message, 'error'));
  $('finalMode').onclick = () => setMode('FINAL').catch(error => setStatus(error.message, 'error'));
  $('sourceRound1').onclick = () => switchSource('ROUND_1').catch(error => setStatus(error.message, 'error'));
  $('sourceRound2').onclick = () => switchSource('ROUND_2').catch(error => setStatus(error.message, 'error'));
  $('sourceRound3').onclick = () => switchSource('ROUND_3').catch(error => setStatus(error.message, 'error'));
  $('sourceFinal').onclick = () => switchSource('FINAL').catch(error => setStatus(error.message, 'error'));
}

async function initFirebase() {
  bindButtons();
  render();
  if (!configLooksReady(firebaseConfig)) {
    setSyncStatus('🔴 Firebase ще не налаштовано. Заповни файл firebase-config.js.', 'error');
    setStatus('Відкрий README_SYNC_SETUP_UA.txt і виконай налаштування Firebase.', 'error');
    return;
  }
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    roomRef = ref(db, `rooms/${ROOM_ID}`);
    stateRef = ref(db, `rooms/${ROOM_ID}/state`);
    spinRef = ref(db, `rooms/${ROOM_ID}/spin`);
    platoonsRef = ref(db, `rooms/${ROOM_ID}/platoonsByRound`);
    firebaseReady = true;

    onValue(ref(db, '.info/connected'), snap => {
      connected = snap.val() === true;
      setSyncStatus(connected ? `🟢 Онлайн • кімната: ${ROOM_ID}` : '🟠 Перепідключення…', connected ? 'ok' : '');
      render();
    });
    onValue(ref(db, '.info/serverTimeOffset'), snap => {
      serverTimeOffset = Number(snap.val()) || 0;
    });
    onValue(platoonsRef, snap => {
      persistentPlatoons = snap.exists() ? mergePlatoonsByRound(snap.val()) : emptyPlatoonsByRound();
      applyPersistentPlatoons(state);
      render();
    }, error => setStatus(`Немає доступу до дошки взводів Firebase: ${error.message}`, 'error'));
    onValue(stateRef, snap => {
      if (!snap.exists()) {
        if (!IS_CONTROL) setStatus('Очікування запуску колеса головним стрімером…');
        return;
      }
      const incoming = ensureStateShape(snap.val());
      const incomingPlatoons = normalizePlatoonsByRound(incoming.platoonsByRound, incoming);
      // Міграція зі старих версій: якщо окремої дошки ще немає, переносимо наявні взводи один раз.
      if (!hasAnyPlatoons(persistentPlatoons) && hasAnyPlatoons(incomingPlatoons)) {
        persistentPlatoons = mergePlatoonsByRound(incomingPlatoons);
        if (IS_CONTROL && platoonsRef) set(platoonsRef, persistentPlatoons).catch(() => {});
      }
      incoming.platoonsByRound = mergePlatoonsByRound(persistentPlatoons, incomingPlatoons);
      state = incoming;
      if (!spinning) rotation = state.rotation;
      render();
      if (!IS_CONTROL) setStatus(`Синхронізація активна • ${new Date().toLocaleTimeString('uk-UA')}`, 'ok');
    }, error => setStatus(`Немає доступу до стану Firebase: ${error.message}`, 'error'));
    onValue(spinRef, snap => {
      const event = snap.val();
      if (event && event.status === 'spinning') playSpin(event);
    }, error => setStatus(`Немає доступу до подій Firebase: ${error.message}`, 'error'));

    if (IS_CONTROL) {
      auth = getAuth(app);
      onAuthStateChanged(auth, user => {
        if (!user) return;
        $('controllerUid').textContent = user.uid;
        $('copyUidBtn').onclick = async () => {
          try {
            await navigator.clipboard.writeText(user.uid);
            $('copyUidBtn').textContent = '✅ СКОПІЙОВАНО';
            setTimeout(() => { $('copyUidBtn').textContent = '📋 КОПІЮВАТИ UID'; }, 1400);
          } catch {
            prompt('Скопіюй UID:', user.uid);
          }
        };
        loadFromSheet(false);
        flushPendingWrites();
      });
      await signInAnonymously(auth);
    }
  } catch (error) {
    setSyncStatus(`🔴 Firebase: ${error.message}`, 'error');
    setStatus('Перевір firebase-config.js, Realtime Database та Anonymous Authentication.', 'error');
  }
}

initFirebase();
