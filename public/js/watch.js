// หน้าดูไลฟ์ (ผู้ชม) — Protocol v1 (ดู PROTOCOL.md)
//  • ลิงก์ Discord (#token) → ดู 1 เกม แบบเดิม
//  • ไม่มีลิงก์ → เข้าสู่ระบบด้วย Google → รายการ "เกมของฉัน" → ดูเกมเดียว หรือหลายเกมพร้อมกัน (สูงสุด 4)
import { parseToken } from './crypto.js?v=2';
import { Lobby } from './lobby.js?v=2';
import { LiveTile } from './stream.js?v=1';
import {
  MAX_FILE, OK_MIME, REASON_TEXT, cleanText, safeJson, safeGiphyUrl, clampInt, sanitizeImageFile,
} from './security.js?v=1';

const $ = id => document.getElementById(id);
const CHUNK = 12 * 1024;
const SEND_GAP_MS = 700;
const MAX_TILES = 4;
const LIST_POLL_MS = 15000;
const LIST_POLL_WATCH_MS = 30000;

const st = {
  mode: 'link',          // 'link' = เปิดจากลิงก์ Discord · 'lobby' = เข้าสู่ระบบ
  lobby: null, acct: null, games: [], selected: new Set(),
  tiles: new Map(),      // id → LiveTile
  focus: '',             // ช่องที่ขยายอยู่ ('' = แสดงทุกช่อง)
  view: '',              // 'list' | 'watch'
  target: 'all',         // ปลายทางแชต: 'all' (Overall) หรือ id ของเกม
  giphyKey: '', lastSend: 0, listTimer: null, listBusy: false,
};

// ---------- หน้าโหลด (ซากุระ) ----------
// ความคืบหน้าเดินตามขั้นตอนจริง: 0 เปิดหน้า → 1 เชื่อมต่อ broker → 2 หาผู้ไลฟ์ → 3 ขอภาพ → เฟรมแรกขึ้นจอ = จบ
const loader = (() => {
  const STEP_TEXT = ['กำลังเปิดหน้า…', 'กำลังเชื่อมต่อเซิร์ฟเวอร์…', 'กำลังค้นหาผู้ไลฟ์…', 'พบผู้ไลฟ์แล้ว <b>กำลังขอภาพ…</b>', 'กำลังรับภาพ…'];
  const PCT = [8, 30, 52, 74, 92];
  const shownAt = Date.now();
  let cur = -1, closed = false;
  function set(i) {
    if (closed || i <= cur) return;
    cur = i;
    const el = $('splashStep');
    el.textContent = '';
    // ข้อความคงที่ของหน้านี้เอง (ไม่ใช่ข้อมูลจากภายนอก) — แยก <b> ด้วย DOM ไม่ใช้ innerHTML
    const m = /^(.*)<b>(.*)<\/b>$/.exec(STEP_TEXT[i]);
    if (m) { el.append(m[1]); const b = document.createElement('b'); b.textContent = m[2]; el.append(b); }
    else el.textContent = STEP_TEXT[i];
    move(PCT[i]);
    [...$('splashSteps').children].forEach((li, k) => {
      li.classList.toggle('done', k < Math.min(i, 4) || (i === 4 && k <= 3));
      li.classList.toggle('active', k === Math.min(i, 3) && i < 4);
    });
  }
  function move(pct) {
    $('splashFill').style.width = pct + '%';
    $('splashPetal').style.left = pct + '%';
  }
  function close(fast = false) {
    if (closed) return;
    closed = true;
    move(100);
    const wait = fast ? 0 : Math.max(0, 1100 - (Date.now() - shownAt));   // เห็นหน้าโหลดอย่างน้อย ~1 วิ ไม่วูบ
    setTimeout(() => {
      $('splash').classList.add('done');
      setTimeout(() => { $('splashPetals').replaceChildren(); $('splash').remove(); }, 700);
    }, wait + 250);
  }
  return { step: set, done: () => close(false), skip: () => close(true), get closed() { return closed; } };
})();

// กลีบซากุระร่วง — DOM + CSS transform ล้วน (ไม่กิน CPU) หยุดเมื่อสลับแท็บ / ปิดเมื่อตั้ง "ลดการเคลื่อนไหว"
function spawnPetals(box, count) {
  if (!box || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.className = 'petal';
    p.style.setProperty('--x', rnd(-5, 100).toFixed(1) + '%');
    p.style.setProperty('--s', rnd(9, 18).toFixed(0) + 'px');
    p.style.setProperty('--d', rnd(9, 17).toFixed(1) + 's');
    p.style.setProperty('--delay', (-rnd(0, 17)).toFixed(1) + 's');
    p.style.setProperty('--sway', rnd(-70, 70).toFixed(0) + 'px');
    p.style.setProperty('--o', rnd(.55, .95).toFixed(2));
    box.appendChild(p);
  }
}
document.addEventListener('visibilitychange', () => document.body.classList.toggle('paused', document.hidden));

// ---------- utils ----------
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function setConn(text) { $('connLabel').textContent = text; }

// ---------- เริ่มหน้า ----------
async function main() {
  loader.step(0);
  spawnPetals($('splashPetals'), 26);
  spawnPetals($('petals'), 14);
  // กันค้างหน้าโหลด (เช่น เน็ตต่อ broker ไม่ได้เลย) — 25 วิแล้วให้กล่องสถานะบนจอวิดีโอบอกแทน
  setTimeout(() => loader.skip(), 25000);
  setupChat();
  setupGate();
  setupGames();
  updateComposer();
  // เปิดลิงก์ใหม่ในแท็บเดิม (เปลี่ยนแค่ #token) เบราว์เซอร์ไม่โหลดหน้าใหม่ → โหลดใหม่เองให้ใช้ลิงก์ใหม่
  window.addEventListener('hashchange', () => { if (parseToken(location.hash)) location.reload(); });
  window.addEventListener('pagehide', () => { for (const t of st.tiles.values()) t.bye(); });
  if (!window.mqtt || !crypto.subtle) {
    loader.skip();
    showView('watch');
    const t = addTile({ id: 'link', name: '' }, false);
    t.setOverlay('⚠️', 'เบราว์เซอร์นี้ไม่รองรับ', 'ลองเปิดด้วย Chrome, Edge หรือ Safari เวอร์ชันล่าสุด');
    return;
  }

  const token = parseToken(location.hash);
  if (token) {
    // เปิดจากลิงก์ Discord (แบบเดิม) — ซ่อน token ออกจากแถบที่อยู่ กันติดภาพหน้าจอ/แชร์ต่อโดยไม่ตั้งใจ
    history.replaceState(null, '', location.pathname);
    showView('watch');
    const t = addTile({ id: 'link', name: '' }, false);
    await t.start(token);
    return;
  }
  st.mode = 'lobby';
  st.lobby = new Lobby();
  await lobbyStart();
}

// ---------- มุมมอง ----------
function showView(v) {
  st.view = v;
  $('games').classList.toggle('hidden', v !== 'list');
  $('watch').classList.toggle('hidden', v !== 'watch');
  $('layout').classList.toggle('list-mode', v === 'list');
  $('backBtn').classList.toggle('hidden', st.mode !== 'lobby');
  document.querySelector('.watch-bar').classList.toggle('hidden', st.mode !== 'lobby');
  if (v === 'list') {
    $('streamTitle').textContent = 'Daily Task Live';
    document.title = 'Daily Task Live';
    setBadge(st.games.some(g => g.live));
    if (st.acct) setConn('เข้าสู่ระบบแล้ว');
  }
  updateComposer();
}

function setBadge(on) {
  $('liveDot').classList.toggle('on', !!on);
  $('liveDot').title = on ? 'กำลังไลฟ์' : 'ไม่ได้ไลฟ์อยู่';
}

// ---------- ช่องดูไลฟ์ ----------
function addTile(game, closable) {
  const tile = new LiveTile({ id: game.id, name: game.name, mode: st.mode, closable }, {
    toast,
    onStep: (t, n) => { if (st.tiles.size === 1 || n <= 2) loader.step(n); },
    onFirstFrame: () => loader.done(),
    onStatus: (t, m) => {
      if (typeof m.giphy === 'string' && m.giphy !== st.giphyKey) updateGiphy(m.giphy);
      if (st.mode === 'link' && t.title) { $('streamTitle').textContent = t.title; document.title = t.title + ' · Daily Task Live'; }
      if (st.mode === 'lobby' && t.title && !t.name) t.setName(t.title);
    },
    onState: () => { refreshWatchHeader(); updateComposer(); },
    onCtl: onCtl,
    onEnd: t => {
      if (st.mode === 'link') { setConn('จบไลฟ์'); loader.skip(); }
      else scheduleList(3000);
      refreshWatchHeader();
    },
    onClose: t => closeTile(t.id),
    onExpand: t => setFocus(st.focus === t.id ? '' : t.id),
  });
  // หน้าโหลดปิดเมื่อมีข้อความสถานะที่ไม่ใช่ "กำลังโหลด" (เช่น พัก/ไม่พบ/จบ)
  const origOverlay = tile.setOverlay.bind(tile);
  tile.setOverlay = (icon, title, sub) => { origOverlay(icon, title, sub); if (icon && !['⏳', '📡'].includes(icon)) loader.skip(); };
  st.tiles.set(game.id, tile);
  $('grid').appendChild(tile.el);
  layoutGrid();
  refreshTargets();
  return tile;
}

function closeTile(id) {
  const t = st.tiles.get(id);
  if (!t) return;
  t.destroy();
  st.tiles.delete(id);
  if (st.focus === id) st.focus = '';
  layoutGrid();
  refreshTargets();
  updateComposer();
  if (!st.tiles.size && st.mode === 'lobby') showList();
}

function closeAllTiles() {
  for (const id of [...st.tiles.keys()]) {
    st.tiles.get(id).destroy();
    st.tiles.delete(id);
  }
  st.focus = '';
  layoutGrid();
  refreshTargets();
}

function setFocus(id) {
  st.focus = st.tiles.has(id) ? id : '';
  layoutGrid();
}

function layoutGrid() {
  const g = $('grid');
  const n = st.tiles.size;
  g.dataset.n = String(st.focus ? 1 : Math.max(1, n));
  g.classList.toggle('focused', !!st.focus);
  for (const [id, t] of st.tiles) {
    t.el.classList.toggle('focus', id === st.focus);
    t.expandBtn.classList.toggle('hidden', n < 2);
    t.expandBtn.textContent = id === st.focus ? '⤡' : '⤢';
  }
  refreshWatchHeader();
}

function refreshWatchHeader() {
  const tiles = [...st.tiles.values()];
  const live = tiles.filter(t => t.live).length;
  if (st.mode === 'lobby' && st.view === 'watch') {
    $('watchCount').textContent = tiles.length > 1 ? `กำลังดู ${tiles.length} เกม · ไลฟ์อยู่ ${live}` : '';
    $('streamTitle').textContent = tiles.length === 1 ? (tiles[0].name || tiles[0].title || 'Daily Task Live') : 'Daily Task Live';
    document.title = $('streamTitle').textContent + (tiles.length === 1 ? ' · Daily Task Live' : '');
  }
  if (st.view === 'watch') setBadge(live > 0);
  const anyOnline = tiles.some(t => t.connState === 'online');
  if (st.view === 'watch' && tiles.length) {
    if (tiles.every(t => t.ended) && st.mode === 'link') setConn('จบไลฟ์');
    else setConn(anyOnline ? 'เชื่อมต่อแล้ว' : 'กำลังเชื่อมต่อ…');
  }
}

// ---------- เข้าสู่ระบบ (lobby — PROTOCOL.md §7) ----------
const ACCT_KEY = 'dt_viewer';

function acctLoad() {
  try {
    const a = JSON.parse(localStorage.getItem(ACCT_KEY) || 'null');
    if (a && /^[A-Za-z0-9_-]{43}$/.test(a.card) && typeof a.sub === 'string' && a.sub) return a;
  } catch {}
  return null;
}
function acctSave(a) { try { localStorage.setItem(ACCT_KEY, JSON.stringify({ card: a.card, sub: a.sub, email: a.email || '' })); } catch {} }
function acctClear() { try { localStorage.removeItem(ACCT_KEY); } catch {} }

async function lobbyStart() {
  const acct = acctLoad();
  if (acct) {
    st.acct = acct;
    showAccount();
    loader.step(1);
    const r = await st.lobby.request({ t: 'list', card: acct.card, sub: acct.sub });
    if (r && r.ok) { applyGames(r); loader.skip(); showList(); return; }
    if (!r) {
      // ร้านไม่ตอบ (โปรแกรมปิด/เน็ตหลุด) — เก็บบัตรไว้ แสดงรายการว่าง ลองใหม่เป็นระยะ
      loader.skip();
      showList();
      listMsg('ยังติดต่อผู้ไลฟ์ไม่ได้ — โปรแกรมของผู้ไลฟ์อาจปิดอยู่ · หน้านี้จะลองใหม่เองอัตโนมัติ');
      scheduleList();
      return;
    }
    expired();
    return;
  }
  await showGate();
}

function expired() {
  acctClear();
  st.acct = null;
  hideAccount();
  closeAllTiles();
  toast('การเข้าสู่ระบบหมดอายุ — กรุณาเข้าสู่ระบบใหม่');
  showGate();
}

function showAccount() {
  $('acct').classList.remove('hidden');
  $('acctName').textContent = st.acct?.email || 'เข้าสู่ระบบแล้ว';
  $('acctName').title = st.acct?.email || '';
}
function hideAccount() { $('acct').classList.add('hidden'); }

async function logout() {
  const a = st.acct;
  acctClear();
  st.acct = null;
  clearTimeout(st.listTimer);
  closeAllTiles();
  if (a) await Promise.race([st.lobby?.request({ t: 'logout', card: a.card }), new Promise(r => setTimeout(r, 1500))]);
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch {}
  location.reload();
}

// ---------- รายการเกม ----------
function cleanGame(g) {
  const id = typeof g?.id === 'string' ? g.id.slice(0, 80) : '';
  if (!id) return null;
  const tok = typeof g.token === 'string' && parseToken(g.token) ? g.token : '';
  return {
    id,
    name: cleanText(g.name, 80, { singleLine: true }) || id,
    title: cleanText(g.title, 120, { singleLine: true }),
    live: !!g.live && !!tok,
    token: tok,
    since: clampInt(g.since, 0, 1e14, 0),
  };
}

function applyGames(r) {
  st.games = (Array.isArray(r.games) ? r.games.slice(0, 50) : []).map(cleanGame).filter(Boolean);
  if (clampInt(r.dropped, 0, 100, 0) > 0) toast('บางเกมถูกนำออกจากรายการ (รหัสเปลี่ยน/ลูกค้าถูกลบ) — เพิ่มใหม่ได้ด้วยไอดี/รหัสล่าสุด');
  for (const id of [...st.selected]) {
    const g = st.games.find(x => x.id === id);
    if (!g || !g.live) st.selected.delete(id);
  }
  // ช่องที่เปิดดูอยู่: ไลฟ์รอบใหม่ (token ใหม่) → ต่อใหม่ · เกมหลุดจากรายการ → ปิดช่อง
  for (const [id, t] of st.tiles) {
    const g = st.games.find(x => x.id === id);
    if (!g) { closeTile(id); continue; }
    t.setName(g.name);
    if (g.token && g.token !== t.token) t.start(g.token);
    else if (!g.token && !t.signal && !t.ended) t.waitOffline();
  }
  renderGames();
}

function listMsg(text) { $('gamesMsg').textContent = text || ''; }

function renderGames() {
  const box = $('gameList');
  box.replaceChildren();
  listMsg('');
  if (!st.games.length) {
    const e = el('div', 'games-empty');
    e.append(el('div', 'games-empty-icon', '🎮'), el('div', 'games-empty-title', 'ยังไม่มีเกมในรายการ'),
      el('div', 'games-empty-sub', 'กด "＋ เพิ่มเกม" แล้วกรอกไอดี/รหัสเกมที่ให้ร้านไว้ — เพิ่มครั้งเดียว ระบบจำไว้กับบัญชี Google นี้'));
    box.appendChild(e);
  }
  for (const g of st.games) {
    const card = el('div', 'game-card' + (g.live ? ' live' : ''));
    const pick = el('input', 'game-pick');
    pick.type = 'checkbox';
    pick.checked = st.selected.has(g.id);
    pick.disabled = !g.live || (!pick.checked && st.selected.size >= MAX_TILES);
    pick.title = g.live ? 'เลือกเพื่อดูพร้อมกันหลายเกม' : 'เกมนี้ยังไม่ได้ไลฟ์';
    pick.setAttribute('aria-label', 'เลือก ' + g.name);
    pick.addEventListener('change', () => {
      if (pick.checked) {
        if (st.selected.size >= MAX_TILES) { pick.checked = false; toast(`ดูพร้อมกันได้สูงสุด ${MAX_TILES} เกม`); return; }
        st.selected.add(g.id);
      } else st.selected.delete(g.id);
      renderGames();
    });
    const info = el('div', 'game-info');
    info.append(el('div', 'game-name', g.name));
    if (g.title) info.append(el('div', 'game-title', g.title));
    const status = el('div', 'game-status');
    if (g.live) {
      const since = g.since ? new Date(g.since).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '';
      status.textContent = '🟢 กำลังไลฟ์' + (since ? ` · เข้าไอดีตั้งแต่ ${since} น.` : '');
    } else status.textContent = '🌙 ไม่ได้ไลฟ์';
    info.append(status);
    const actions = el('div', 'game-actions');
    const watch = el('button', 'send-btn game-watch', '▶ ดู');
    watch.type = 'button';
    watch.disabled = !g.live;
    watch.addEventListener('click', () => watchGames([g.id]));
    const del = el('button', 'game-del', '🗑');
    del.type = 'button';
    del.title = 'เอาเกมนี้ออกจากรายการ';
    del.addEventListener('click', () => removeGame(g));
    actions.append(watch, del);
    card.append(pick, info, actions);
    box.appendChild(card);
  }
  const n = st.selected.size;
  $('watchSelBtn').disabled = n === 0;
  $('watchSelBtn').textContent = n > 1 ? `▶ ดูพร้อมกัน ${n} เกม` : n === 1 ? '▶ ดูเกมที่เลือก' : '▶ ดูพร้อมกัน';
  if (st.view === 'list') setBadge(st.games.some(g => g.live));
}

async function refreshList() {
  if (!st.acct || st.listBusy) return;
  st.listBusy = true;
  const r = await st.lobby.request({ t: 'list', card: st.acct.card, sub: st.acct.sub });
  st.listBusy = false;
  if (!st.acct) return;
  if (!r) { if (st.view === 'list') listMsg('ยังติดต่อผู้ไลฟ์ไม่ได้ — จะลองใหม่เองอัตโนมัติ'); return; }
  if (!r.ok) { expired(); return; }
  applyGames(r);
}

function scheduleList(delay) {
  clearTimeout(st.listTimer);
  if (!st.acct) return;
  st.listTimer = setTimeout(async () => {
    if (!(document.hidden && st.view === 'list')) await refreshList();
    scheduleList();
  }, delay ?? (st.view === 'watch' ? LIST_POLL_WATCH_MS : LIST_POLL_MS));
}

function showList() {
  showView('list');
  renderGames();
  if (!st.games.length) openAddForm();
  scheduleList();
}

function watchGames(ids) {
  const games = ids.map(id => st.games.find(g => g.id === id)).filter(g => g && g.live).slice(0, MAX_TILES);
  if (!games.length) { toast('เกมที่เลือกยังไม่ได้ไลฟ์'); return; }
  // เปิดช่องตามลำดับในรายการ (เข้าไอดีก่อน = ช่องแรก) · ช่องที่เปิดอยู่แล้วแต่ไม่ได้เลือก → ปิด
  for (const id of [...st.tiles.keys()]) if (!games.some(g => g.id === id)) closeTile(id);
  for (const g of games) {
    let t = st.tiles.get(g.id);
    if (!t) { t = addTile(g, true); t.start(g.token); }
    else $('grid').appendChild(t.el);
  }
  st.focus = '';
  layoutGrid();
  st.target = games.length > 1 ? 'all' : games[0].id;
  refreshTargets();
  showView('watch');
  scheduleList();
}

async function removeGame(g) {
  if (!confirm(`เอา "${g.name}" ออกจากรายการ?\n(เพิ่มกลับได้ด้วยไอดี/รหัสเกม)`)) return;
  const r = await st.lobby.request({ t: 'remove', card: st.acct.card, sub: st.acct.sub, id: g.id });
  if (!r) { toast('ติดต่อผู้ไลฟ์ไม่ได้ ลองใหม่อีกครั้ง'); return; }
  if (!r.ok) { expired(); return; }
  st.selected.delete(g.id);
  applyGames(r);
  toast('เอาออกจากรายการแล้ว');
}

// ---------- เพิ่มเกม ----------
const addState = { pick: '', busy: false };
const REASON_ADD = {
  bad: 'ไอดีหรือรหัสผ่านไม่ถูกต้อง',
  expired: 'การเข้าสู่ระบบหมดอายุ',
};

function openAddForm() {
  $('addForm').classList.remove('hidden');
  $('addGameBtn').classList.add('hidden');
  addState.pick = '';
  $('aChoose').replaceChildren();
  addMsg('');
  setTimeout(() => $('aUser').focus(), 50);
}
function closeAddForm() {
  $('addForm').classList.add('hidden');
  $('addGameBtn').classList.remove('hidden');
  $('aPass').value = '';
}
function addMsg(text, isErr = false) {
  const m = $('aMsg');
  m.textContent = text;
  m.classList.toggle('err', isErr);
}

async function addSubmit(ev) {
  ev.preventDefault();
  if (addState.busy || !st.acct) return;
  const u = $('aUser').value.trim();
  const p = $('aPass').value;
  if (!u || !p) { addMsg('กรอกไอดีและรหัสผ่านให้ครบ', true); return; }
  addState.busy = true;
  $('aSubmit').disabled = true;
  addMsg('กำลังตรวจสอบ…');
  const req = { t: 'add', card: st.acct.card, sub: st.acct.sub, u: u.slice(0, 200), p: p.slice(0, 200) };
  if (addState.pick) req.pick = addState.pick;
  const r = await st.lobby.request(req);
  addState.busy = false;
  $('aSubmit').disabled = false;
  if (!r) { addMsg('ติดต่อผู้ไลฟ์ไม่ได้ ลองใหม่อีกครั้ง', true); return; }
  if (r.ok) {
    $('aUser').value = '';
    closeAddForm();
    applyGames(r);
    const g = st.games.find(x => x.id === r.added);
    toast(g ? `เพิ่ม "${g.name}" แล้ว` : 'เพิ่มเกมแล้ว');
    return;
  }
  if (r.reason === 'expired') { expired(); return; }
  if (r.reason === 'choose' && Array.isArray(r.options)) { renderChoose(r.options); return; }
  if (r.reason === 'locked') {
    addMsg(`ลองผิดหลายครั้งเกินไป — รออีก ${Math.ceil(clampInt(r.wait, 1, 86400, 900) / 60)} นาที`, true);
    return;
  }
  addMsg(Object.hasOwn(REASON_ADD, r.reason) ? REASON_ADD[r.reason] : 'เพิ่มเกมไม่สำเร็จ', true);
}

// ไอดี/รหัสเดียวกันใช้กับลูกค้าหลายรายการ → ให้เลือก (ชื่อกรองก่อนแสดง, ปุ่มสร้างด้วย DOM)
function renderChoose(options) {
  const box = $('aChoose');
  box.replaceChildren();
  addMsg('ไอดีนี้มีหลายรายการ — เลือกรายการที่ต้องการเพิ่ม');
  for (const o of options.slice(0, 10)) {
    const id = typeof o?.id === 'string' ? o.id.slice(0, 80) : '';
    if (!id) continue;
    const b = el('button', 'gate-choice', cleanText(o.name, 80, { singleLine: true }) || id);
    b.type = 'button';
    b.addEventListener('click', () => { addState.pick = id; $('addForm').requestSubmit(); });
    box.appendChild(b);
  }
}

function setupGames() {
  $('addGameBtn').addEventListener('click', openAddForm);
  $('aCancel').addEventListener('click', closeAddForm);
  $('addForm').addEventListener('submit', addSubmit);
  $('aShowPass').addEventListener('click', () => {
    const inp = $('aPass');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('aShowPass').textContent = inp.type === 'password' ? '👁' : '🙈';
  });
  $('watchSelBtn').addEventListener('click', () => watchGames([...st.selected]));
  $('refreshBtn').addEventListener('click', async () => { $('refreshBtn').disabled = true; await refreshList(); $('refreshBtn').disabled = false; });
  $('backBtn').addEventListener('click', () => {
    // กลับไปหน้ารายการ = เลิกดูทุกช่อง (ไม่กินโควตาผู้ชม/เน็ตของผู้ไลฟ์)
    for (const id of st.tiles.keys()) if (!st.selected.has(id)) st.selected.add(id);
    closeAllTiles();
    showList();
    refreshList();
  });
  $('logoutBtn').addEventListener('click', logout);
}

// ---------- หน้าเข้าสู่ระบบ (Google) ----------
const gate = { busy: false };

async function showGate() {
  loader.skip();
  showView('list');
  $('games').classList.add('hidden');
  setConn('ยังไม่ได้เข้าสู่ระบบ');
  $('gate').classList.remove('hidden');
  gateMsg('กำลังติดต่อผู้ไลฟ์…');
  const hello = await st.lobby.request({ t: 'hello' });
  if (!hello) { gateMsg('ติดต่อผู้ไลฟ์ไม่ได้ — โปรแกรมของผู้ไลฟ์อาจปิดอยู่ ลองรีเฟรชหน้านี้ภายหลัง', true); return; }
  const cid = typeof hello.clientId === 'string' ? hello.clientId : '';
  if (!hello.ok || !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(cid)) {
    gateMsg('ร้านยังไม่เปิดการเข้าสู่ระบบ — กรุณาใช้ลิงก์จาก Discord', true);
    return;
  }
  gateMsg('');
  try { await loadGoogle(); } catch { gateMsg('โหลดปุ่ม Google ไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ตแล้วรีเฟรชหน้า', true); return; }
  window.google.accounts.id.initialize({
    client_id: cid, callback: onGoogle, auto_select: false, cancel_on_tap_outside: true,
    ux_mode: 'popup', use_fedcm_for_button: true, itp_support: true,
  });
  window.google.accounts.id.renderButton($('gBtn'), {
    theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'left', locale: 'th',
  });
}

function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (window.google?.accounts?.id ? resolve() : reject(new Error('gsi')));
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// อ่าน email จาก ID token เพื่อแสดงผลเท่านั้น — ตัวตรวจลายเซ็นจริงคือโปรแกรมผู้ไลฟ์
function jwtClaims(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(part + '='.repeat((4 - part.length % 4) % 4));
    return safeJson(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))), 8192);
  } catch { return null; }
}

async function onGoogle(resp) {
  if (gate.busy) return;
  const c = jwtClaims(resp?.credential);
  if (!c || typeof c.sub !== 'string') { gateMsg('ยืนยันบัญชี Google ไม่สำเร็จ ลองใหม่อีกครั้ง', true); return; }
  gate.busy = true;
  gateMsg('กำลังตรวจสอบบัญชี Google…');
  const r = await st.lobby.request({ t: 'login', gid: resp.credential });
  gate.busy = false;
  if (!r) { gateMsg('ติดต่อผู้ไลฟ์ไม่ได้ ลองใหม่อีกครั้ง', true); return; }
  if (!r.ok || !/^[A-Za-z0-9_-]{43}$/.test(r.card) || typeof r.sub !== 'string') {
    gateMsg(r.reason === 'disabled' ? 'ร้านยังไม่เปิดการเข้าสู่ระบบ — กรุณาใช้ลิงก์จาก Discord'
      : 'ยืนยันบัญชี Google ไม่สำเร็จ ลองกดเข้าสู่ระบบด้วย Google ใหม่', true);
    return;
  }
  st.acct = { card: r.card, sub: r.sub, email: cleanText(c.email, 120, { singleLine: true }) };
  acctSave(st.acct);
  $('gate').classList.add('hidden');
  showAccount();
  applyGames(r);
  showList();
}

function gateMsg(text, isErr = false) {
  const m = $('gMsg');
  m.textContent = text;
  m.classList.toggle('err', isErr);
}

function setupGate() { /* ปุ่ม Google สร้างตอนแสดงหน้าเข้าสู่ระบบ */ }

// ---------- DataChannel (ตอบกลับจากผู้ไลฟ์) ----------
const pendingAcks = new Map(); // id -> element
function onCtl(tile, m) {
  if (m.t === 'ack') {
    const row = pendingAcks.get(String(m.id || ''));
    if (row) { row.classList.add('acked'); pendingAcks.delete(m.id); }
  } else if (m.t === 'rate') {
    toast(`ส่งเร็วเกินไป รออีก ${Math.ceil(clampInt(m.wait, 1, 600000, 1000) / 1000)} วินาที`);
  } else if (m.t === 'error') {
    toast(Object.hasOwn(REASON_TEXT, m.reason) ? REASON_TEXT[m.reason] : 'ส่งไม่สำเร็จ');
  }
}

// ---------- ปลายทางแชต ----------
// ดูหลายเกม: เลือกส่งถึงเกมไหน หรือ "Overall" (ไม่ระบุเกม — ส่งครั้งเดียว ป๊อปอัปไม่ใส่ชื่อลูกค้า)
function refreshTargets() {
  const sel = $('chatTarget');
  const tiles = [...st.tiles.values()];
  const multi = tiles.length > 1;
  sel.classList.toggle('hidden', !multi);
  if (!multi) { st.target = tiles[0]?.id || 'all'; return; }
  const opts = [['all', '🌐 Overall (ทุกเกม)'], ...tiles.map(t => [t.id, '🎮 ' + (t.name || t.title || 'เกม')])];
  sel.replaceChildren(...opts.map(([v, label]) => { const o = el('option', null, label); o.value = v; return o; }));
  if (!opts.some(([v]) => v === st.target)) st.target = 'all';
  sel.value = st.target;
}

function targetTile() {
  const tiles = [...st.tiles.values()];
  if (tiles.length <= 1) return { tile: tiles[0] || null, all: false };
  if (st.target === 'all') return { tile: tiles.find(t => t.open) || null, all: true };
  return { tile: st.tiles.get(st.target) || null, all: false };
}

function targetLabel(all, tile) {
  if (st.tiles.size <= 1) return '';
  return all ? 'ทุกเกม' : (tile?.name || tile?.title || '');
}

function updateComposer() {
  const any = [...st.tiles.values()].some(t => t.open);
  const enabled = st.view === 'watch' && any;
  for (const id of ['msgInput', 'sendBtn', 'pickerBtn', 'imageBtn', 'chatTarget']) $(id).disabled = !enabled;
  $('msgInput').placeholder = enabled ? 'พิมพ์ข้อความ…' : 'รอเชื่อมต่อไลฟ์ก่อนจึงจะส่งข้อความได้';
}

function canSend() {
  const { tile, all } = targetTile();
  if (!tile || !tile.open) { toast(st.tiles.size > 1 && !all ? 'เกมที่เลือกยังไม่ได้เชื่อมต่อ' : 'ยังไม่ได้เชื่อมต่อไลฟ์'); return null; }
  const wait = st.lastSend + SEND_GAP_MS - Date.now();
  if (wait > 0) { toast('ส่งเร็วเกินไป รอสักครู่'); return null; }
  st.lastSend = Date.now();
  return { tile, all };
}

function logItem(node, label) {
  const log = $('chatLog');
  const row = el('div', 'msg');
  if (label) row.appendChild(el('span', 'msg-to', '→ ' + label));
  row.appendChild(node);
  row.appendChild(el('span', 'tick', '✓'));
  log.appendChild(row);
  while (log.children.length > 60) log.removeChild(log.children[1]);
  log.scrollTop = log.scrollHeight;
  return row;
}

function withAll(obj, all) { return all ? { ...obj, all: true } : obj; }

function sendText(raw) {
  const text = cleanText(raw, 500);   // ลบอักขระควบคุม/กลับทิศ/แท็ก HTML/javascript: ก่อนส่ง
  if (!text) { if (raw.trim()) toast('ข้อความนี้มีแต่อักขระที่ไม่อนุญาต จึงไม่ส่ง'); return !!raw.trim(); }
  const to = canSend();
  if (!to) return false;
  const id = rid();
  to.tile.sendCtl(withAll({ t: 'chat', id, text }, to.all));
  pendingAcks.set(id, logItem(el('span', 'msg-text', text), targetLabel(to.all, to.tile)));
  return true;
}

function sendGif(rawUrl, rawW, rawH, rawPreview) {
  const url = safeGiphyUrl(rawUrl);
  if (!url) { toast('GIF นี้มาจากแหล่งที่ไม่อนุญาต'); return; }
  const preview = safeGiphyUrl(rawPreview) || url;
  const to = canSend();
  if (!to) return;
  const id = rid();
  to.tile.sendCtl(withAll({ t: 'gif', id, url, w: clampInt(rawW, 1, 4096, 200), h: clampInt(rawH, 1, 4096, 200) }, to.all));
  const img = el('img', 'msg-img');
  img.src = preview;
  img.alt = 'GIF';
  pendingAcks.set(id, logItem(img, targetLabel(to.all, to.tile)));
  closePicker();
}

async function sendFile(file, kind, name = 'image') {
  const pre = targetTile();
  if (!pre.tile || !pre.tile.open) { toast('ยังไม่ได้เชื่อมต่อไลฟ์'); return; }
  // ตรวจไบต์จริง + สแกนโค้ดฝัง + จำกัดขนาด + วาดใหม่ลบข้อมูลแฝง (GIF คงไฟล์เดิม)
  const safe = await sanitizeImageFile(file);
  if (!safe.ok) { toast(REASON_TEXT[safe.reason] || 'ส่งไม่สำเร็จ'); return; }
  if (safe.mime === 'image/gif' && kind === 'image') kind = 'gif';
  const blob = safe.blob;
  const to = canSend();
  if (!to) return;
  const id = rid();
  const dc = to.tile.dc;
  const cleanName = cleanText(String(name), 80, { singleLine: true }).replace(/[\\/:*?"<>|]/g, '_') || 'image';
  to.tile.sendCtl(withAll({ t: 'file-start', id, kind, mime: safe.mime, size: blob.size, name: cleanName }, to.all));
  const img = el('img', 'msg-img');
  img.src = URL.createObjectURL(blob);
  img.alt = kind;
  const row = logItem(img, targetLabel(to.all, to.tile));
  row.classList.add('sending');
  pendingAcks.set(id, row);
  const buf = new Uint8Array(await blob.arrayBuffer());
  for (let seq = 0, off = 0; off < buf.length; seq++, off += CHUNK) {
    if (dc.readyState !== 'open') { toast('การเชื่อมต่อหลุดระหว่างส่งไฟล์'); return; }
    if (dc.bufferedAmount > 1024 * 1024) {
      await new Promise(r => dc.addEventListener('bufferedamountlow', r, { once: true }));
    }
    let bin = '';
    const part = buf.subarray(off, off + CHUNK);
    for (let i = 0; i < part.length; i++) bin += String.fromCharCode(part[i]);
    dc.send(JSON.stringify({ t: 'file-chunk', id, seq, data: btoa(bin) }));
  }
  to.tile.sendCtl({ t: 'file-end', id });
  row.classList.remove('sending');
  closePicker();
}

// ---------- chat UI ----------
const EMOJIS = ('😀 😁 😂 🤣 😊 😍 🥰 😘 😎 🤩 🥳 😇 🙂 😉 😋 😜 🤪 🤗 🤔 🫡 😴 😪 😮 😱 😭 😢 😤 😡 🤬 😳 🥺 😅 😆 🙃 ' +
  '👍 👎 👏 🙌 🙏 💪 👌 ✌️ 🤞 🫶 👀 🤝 💯 🔥 ✨ ⭐ 🌟 💥 🎉 🎊 🎁 🏆 🥇 🎯 🎮 🕹️ ⚔️ 🛡️ 💎 💰 🪙 ' +
  '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💖 🌸 🌈 ☀️ 🌙 ⚡ ❄️ 🍀 🍰 🍜 ☕ 🧋 🐱 🐶 🐰 🦊 🐼 🐧 🐟 👻 💀 🤖').split(' ');

function setupChat() {
  $('composer').addEventListener('submit', e => {
    e.preventDefault();
    if (sendText($('msgInput').value)) $('msgInput').value = '';
  });
  $('chatTarget').addEventListener('change', e => { st.target = e.target.value; });
  $('pickerBtn').addEventListener('click', () => $('picker').classList.toggle('hidden'));
  $('imageBtn').addEventListener('click', () => $('fileImage').click());
  $('fileImage').addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) sendFile(f, f.type === 'image/gif' ? 'gif' : 'image', f.name);
  });
  $('gifUploadBtn').addEventListener('click', () => $('fileGif').click());
  $('fileGif').addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) sendFile(f, 'gif', f.name);
  });

  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    for (const name of ['emoji', 'sticker', 'gif']) $('tab-' + name).classList.toggle('hidden', btn.dataset.tab !== name);
    if (btn.dataset.tab === 'gif') loadGifs($('gifQuery').value);
  }));

  const grid = $('emojiGrid');
  for (const em of EMOJIS) {
    const b = el('button', 'emoji', em);
    b.type = 'button';
    b.addEventListener('click', () => {
      const inp = $('msgInput');
      inp.value = (inp.value + em).slice(0, 500);
      inp.focus();
    });
    grid.appendChild(b);
  }

  loadPack();
  renderMine();
  $('addStickerBtn').addEventListener('click', () => $('fileSticker').click());
  $('fileSticker').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!OK_MIME.includes(f.type) || f.size > MAX_FILE) { toast('สติกเกอร์ต้องเป็นรูป (≤ 5 MB)'); return; }
    const safe = await sanitizeImageFile(f);   // เก็บเฉพาะไฟล์ที่ผ่านการตรวจ/ล้างข้อมูลแฝงแล้ว
    if (!safe.ok) { toast(REASON_TEXT[safe.reason]); return; }
    await stickerDb('put', { id: rid() + Date.now().toString(36), blob: safe.blob, added: Date.now() });
    renderMine();
    toast('เพิ่มสติกเกอร์แล้ว (เก็บไว้ในเบราว์เซอร์นี้เท่านั้น)');
  });

  let gifTimer = null;
  $('gifQuery').addEventListener('input', e => {
    clearTimeout(gifTimer);
    gifTimer = setTimeout(() => loadGifs(e.target.value), 450);
  });
  updateGiphy('');
}

function closePicker() { $('picker').classList.add('hidden'); }

// ข้อความว่างในตาราง — ใช้ textContent (ไม่มี innerHTML ในหน้านี้เลย)
function emptyMsg(grid, text) {
  grid.replaceChildren(el('div', 'empty', text));
}

async function loadPack() {
  const grid = $('packGrid');
  try {
    const r = await fetch('./stickers/index.json', { cache: 'no-cache' });
    const list = r.ok ? await r.json() : [];
    if (!Array.isArray(list) || !list.length) {
      emptyMsg(grid, 'ยังไม่มีสติกเกอร์ชุดของร้าน');
      return;
    }
    for (const item of list) {
      const file = typeof item === 'string' ? item : item.file;
      if (!file || !/^[\w.\-]+\.(png|jpe?g|gif|webp)$/i.test(file)) continue;
      const img = document.createElement('img');
      img.src = './stickers/' + file;
      img.alt = cleanText(item && item.name, 60, { singleLine: true }) || file;
      img.title = img.alt;
      img.loading = 'lazy';
      img.addEventListener('click', async () => {
        const blob = await (await fetch(img.src)).blob();
        sendFile(blob, 'sticker', file);
      });
      grid.appendChild(img);
    }
  } catch {
    emptyMsg(grid, 'โหลดสติกเกอร์ไม่สำเร็จ');
  }
}

function stickerDb(op, value) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('dtlive', 1); } catch { resolve(op === 'all' ? [] : null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore('stickers', { keyPath: 'id' });
    req.onerror = () => resolve(op === 'all' ? [] : null);
    req.onsuccess = () => {
      const tx = req.result.transaction('stickers', op === 'all' ? 'readonly' : 'readwrite');
      const s = tx.objectStore('stickers');
      const r = op === 'all' ? s.getAll() : op === 'put' ? s.put(value) : s.delete(value);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(op === 'all' ? [] : null);
    };
  });
}

async function renderMine() {
  const grid = $('mineGrid');
  grid.replaceChildren();
  const items = (await stickerDb('all')) || [];
  if (!items.length) {
    emptyMsg(grid, 'กด ＋ เพิ่ม เพื่อใส่รูปของคุณเป็นสติกเกอร์');
    return;
  }
  items.sort((a, b) => a.added - b.added);
  for (const it of items) {
    const wrap = el('div', 'mine-item');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(it.blob);
    img.alt = 'sticker';
    img.addEventListener('click', () => sendFile(it.blob, 'sticker', 'sticker'));
    const del = el('button', 'del', '×');
    del.type = 'button';
    del.title = 'ลบสติกเกอร์นี้';
    del.addEventListener('click', async ev => { ev.stopPropagation(); await stickerDb('delete', it.id); renderMine(); });
    wrap.append(img, del);
    grid.appendChild(wrap);
  }
}

function updateGiphy(key) {
  st.giphyKey = key || '';
  $('gifQuery').classList.toggle('hidden', !st.giphyKey);
  $('giphyAttr').classList.toggle('hidden', !st.giphyKey);
  if (!st.giphyKey) emptyMsg($('gifGrid'), 'ค้นหา GIF ยังไม่เปิดใช้ — อัปโหลดไฟล์ GIF ของคุณเองได้');
}

let gifReq = 0;
async function loadGifs(q) {
  if (!st.giphyKey) return;
  const my = ++gifReq;
  const grid = $('gifGrid');
  const base = 'https://api.giphy.com/v1/gifs/';
  const params = new URLSearchParams({ api_key: st.giphyKey, limit: '24', rating: 'pg-13' });
  let url = base + 'trending?' + params;
  const query = cleanText(q, 50, { singleLine: true });
  if (query) { params.set('q', query); url = base + 'search?' + params; }
  try {
    const r = await fetch(url);
    if (my !== gifReq) return;
    if (!r.ok) { emptyMsg(grid, 'ค้นหา GIF ไม่สำเร็จ (อาจเกินโควตาชั่วคราว)'); return; }
    const body = await r.json();
    const data = Array.isArray(body && body.data) ? body.data.slice(0, 50) : [];
    grid.replaceChildren();
    for (const g of data) {
      const send = g && g.images && (g.images.fixed_height || g.images.downsized);
      const prev = g && g.images && (g.images.fixed_height_small || send);
      const sendUrl = send && safeGiphyUrl(send.url);
      const prevUrl = (prev && safeGiphyUrl(prev.url)) || sendUrl;
      if (!sendUrl) continue;   // URL นอก media*.giphy.com/media/ → ทิ้ง
      const img = document.createElement('img');
      img.src = prevUrl;
      img.alt = cleanText(g.title, 80, { singleLine: true }) || 'GIF';
      img.loading = 'lazy';
      img.addEventListener('click', () => sendGif(sendUrl, send.width, send.height, prevUrl));
      grid.appendChild(img);
    }
    if (!grid.children.length) emptyMsg(grid, 'ไม่พบ GIF');
  } catch {
    emptyMsg(grid, 'ค้นหา GIF ไม่สำเร็จ');
  }
}

main();
