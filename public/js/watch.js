// หน้าดูไลฟ์ (ผู้ชม) — Protocol v1 (ดู PROTOCOL.md)
import { parseToken, deriveSession } from './crypto.js?v=2';
import { Signal } from './signal.js?v=2';
import { Lobby } from './lobby.js?v=1';
import {
  MAX_FILE, OK_MIME, REASON_TEXT, cleanText, safeJson, safeGiphyUrl, safeGiphyKey, clampInt, sanitizeImageFile,
} from './security.js?v=1';

const $ = id => document.getElementById(id);
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];
const CHUNK = 12 * 1024;
const SEND_GAP_MS = 700;
const STATUS_TIMEOUT_MS = 12000;
// ต่อ broker ได้แล้วแต่ยังไม่เคยได้ status เลยนานเท่านี้ → บอกผู้ชมว่ายังไม่พบผู้ไลฟ์ (แต่ยังรอต่อ)
const NO_STREAMER_MS = 20000;

const vid = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
const video = $('video');

const st = {
  signal: null, pc: null, dc: null, live: false, ended: false,
  lastStatus: 0, onlineSince: 0, noStreamerShown: false, giphyKey: '', retryTimer: null, answerTimer: null, lastSend: 0,
  quality: lsGet('dt_quality', 'source'),
  // fps ที่อยากได้ — ผู้ไลฟ์ปัดลงให้ไม่เกิน Hz จอของตัวเอง แล้วบอกค่าจริงกลับมาใน info
  fps: Number(lsGet('dt_fps', '30')) || 30,
  // 'link' = เปิดจากลิงก์ Discord · 'lobby' = เข้าสู่ระบบ (บัตรผู้ชมใน localStorage)
  mode: 'link', lobby: null, acct: null, curToken: '', resumeTimer: null,
};

// ---------- หน้าโหลด (ซากุระ) ----------
// ความคืบหน้าเดินตามขั้นตอนจริง: 0 เปิดหน้า → 1 เชื่อมต่อ broker → 2 หาผู้ไลฟ์ → 3 ขอภาพ → เฟรมแรกขึ้นจอ = จบ
// ไม่มีภาพให้ดู (ลิงก์ผิด/พักไลฟ์/จบ/ไม่พบผู้ไลฟ์/เต็ม) → ปิดหน้าโหลดแล้วให้กล่องข้อความบนจอวิดีโอบอกแทน
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
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function overlay(icon, title, sub = '') {
  const o = $('overlay');
  if (!icon) { o.classList.add('hidden'); return; }
  o.classList.remove('hidden');
  // ข้อความสถานะที่ไม่ใช่ "กำลังโหลด" (พักไลฟ์/จบ/ไม่พบ/เต็ม/ลิงก์ผิด) → ปิดหน้าโหลดให้ผู้ชมเห็นข้อความ
  if (!['⏳', '📡'].includes(icon)) loader.skip();
  $('overlayIcon').textContent = icon;
  $('overlayTitle').textContent = title;
  $('overlaySub').textContent = sub;
}

function setLive(on) {
  st.live = on;
  $('liveDot').classList.toggle('on', on);
  $('liveDot').title = on ? 'กำลังไลฟ์' : 'ไม่ได้ไลฟ์อยู่';
}

function setComposer(enabled) {
  for (const id of ['msgInput', 'sendBtn', 'pickerBtn', 'imageBtn']) $(id).disabled = !enabled;
  $('msgInput').placeholder = enabled ? 'พิมพ์ข้อความ…' : 'รอเชื่อมต่อไลฟ์ก่อนจึงจะส่งข้อความได้';
}

// ---------- signaling ----------
async function main() {
  loader.step(0);
  spawnPetals($('splashPetals'), 26);
  spawnPetals($('petals'), 14);
  // กันค้างหน้าโหลด (เช่น เน็ตต่อ broker ไม่ได้เลย) — 25 วิแล้วให้กล่องสถานะบนจอวิดีโอบอกแทน
  setTimeout(() => loader.skip(), 25000);
  setComposer(false);
  setupControls();
  setupChat();
  setupGate();
  // เปิดลิงก์ใหม่ในแท็บเดิม (เปลี่ยนแค่ #token) เบราว์เซอร์ไม่โหลดหน้าใหม่ → โหลดใหม่เองให้ใช้ลิงก์ใหม่
  window.addEventListener('hashchange', () => { if (parseToken(location.hash)) location.reload(); });
  if (!window.mqtt || !crypto.subtle) {
    overlay('⚠️', 'เบราว์เซอร์นี้ไม่รองรับ', 'ลองเปิดด้วย Chrome, Edge หรือ Safari เวอร์ชันล่าสุด');
    return;
  }
  setInterval(checkStatusTimeout, 2000);
  window.addEventListener('pagehide', () => { st.signal?.send({ t: 'bye', vid }); });

  const token = parseToken(location.hash);
  if (token) {
    // เปิดจากลิงก์ Discord (แบบเดิม) — ซ่อน token ออกจากแถบที่อยู่ กันติดภาพหน้าจอ/แชร์ต่อโดยไม่ตั้งใจ
    history.replaceState(null, '', location.pathname);
    await connectToken(token);
    return;
  }
  // ไม่มีลิงก์ → เข้าสู่ระบบ (Google + ไอดี/รหัสเกม) แล้วรับ token ไลฟ์ของลูกค้าจากโปรแกรมผู้ไลฟ์
  st.mode = 'lobby';
  await lobbyStart();
}

// ต่อไลฟ์ด้วย token (ใช้ทั้งลิงก์ Discord และหลังเข้าสู่ระบบ) — เรียกซ้ำได้: ทิ้งการเชื่อมต่อเดิมก่อน
async function connectToken(tokenBytes) {
  closePeer();
  clearTimeout(st.retryTimer);
  st.signal?.stop();
  Object.assign(st, { signal: null, ended: false, lastStatus: 0, onlineSince: 0, noStreamerShown: false });
  const session = await deriveSession(tokenBytes);
  loader.step(1);
  overlay('⏳', 'กำลังเชื่อมต่อ…', 'รอสัญญาณจากผู้ไลฟ์');
  st.signal = new Signal(session, onSignal, onConnState);
  st.signal.start();
}

// ---------- เข้าสู่ระบบ (lobby — PROTOCOL.md §7) ----------
const ACCT_KEY = 'dt_viewer';
const REASON_LOGIN = {
  bad: 'ไอดีหรือรหัสผ่านไม่ถูกต้อง',
  offline: 'ไอดีนี้ยังไม่ได้เริ่มงาน — ยังไม่มีไลฟ์ให้ดูตอนนี้ ลองใหม่เมื่อเริ่มงาน',
  google: 'ยืนยันบัญชี Google ไม่สำเร็จ ลองกดเข้าสู่ระบบด้วย Google ใหม่',
  disabled: 'ร้านยังไม่เปิดการเข้าสู่ระบบ — กรุณาใช้ลิงก์จาก Discord',
};

function acctLoad() {
  try {
    const a = JSON.parse(localStorage.getItem(ACCT_KEY) || 'null');
    if (a && /^[A-Za-z0-9_-]{43}$/.test(a.card) && typeof a.sub === 'string' && a.sub) return a;
  } catch {}
  return null;
}
function acctSave(a) { try { localStorage.setItem(ACCT_KEY, JSON.stringify(a)); } catch {} }
function acctClear() { try { localStorage.removeItem(ACCT_KEY); } catch {} }

async function lobbyStart() {
  st.lobby = new Lobby();
  const acct = acctLoad();
  if (acct) {
    st.acct = acct;
    showAccount();
    loader.step(1);
    const ok = await resumeOnce(true);
    if (ok) { scheduleResume(); return; }
  }
  await showGate();
}

// ใช้บัตรผู้ชมที่จำไว้ — คืน true ถ้าบัตรยังใช้ได้ (ไม่ว่าจะกำลังไลฟ์หรือไม่)
async function resumeOnce(first = false) {
  if (!st.acct) return false;
  const r = await st.lobby.request({ t: 'resume', card: st.acct.card, sub: st.acct.sub });
  if (!st.acct) return false;
  if (!r) {
    // ร้านไม่ตอบ (โปรแกรมปิด/เน็ตหลุด) — เก็บบัตรไว้ ลองใหม่รอบหน้า
    if (first || !st.curToken) {
      setLive(false);
      overlay('📴', 'ยังติดต่อผู้ไลฟ์ไม่ได้', 'โปรแกรมของผู้ไลฟ์อาจปิดอยู่ · หน้านี้จะลองใหม่เองอัตโนมัติ');
      $('connLabel').textContent = 'รอผู้ไลฟ์…';
    }
    return true;
  }
  if (!r.ok) {
    acctClear();
    st.acct = null;
    hideAccount();
    closePeer();
    st.signal?.stop();
    st.signal = null;
    st.curToken = '';
    toast('การเข้าสู่ระบบหมดอายุ (เปลี่ยนรหัส/ออกจากระบบ) — กรุณาเข้าสู่ระบบใหม่');
    await showGate();
    return false;
  }
  applyWatch(r);
  return true;
}

function applyWatch(r) {
  const name = cleanText(r.name, 80, { singleLine: true });
  if (name && st.acct) { st.acct.name = name; acctSave(st.acct); $('acctName').textContent = name; }
  const tok = typeof r.token === 'string' ? r.token : '';
  if (tok && tok !== st.curToken) {
    const bytes = parseToken(tok);
    if (bytes) { st.curToken = tok; connectToken(bytes); }
  } else if (!tok && !st.signal) {
    setLive(false);
    overlay('🌙', 'ยังไม่มีไลฟ์ตอนนี้', 'ไลฟ์จะเริ่มเมื่อเริ่มงานของไอดีนี้ · หน้านี้จะเชื่อมต่อให้เองอัตโนมัติ');
    $('connLabel').textContent = 'รอไลฟ์…';
  }
}

// ถามร้านเป็นระยะ: ไลฟ์รอบใหม่ (token ใหม่) / บัตรถูกยกเลิก — ถี่ตอนรอ ห่างตอนกำลังดู
function scheduleResume() {
  clearTimeout(st.resumeTimer);
  if (!st.acct) return;
  const watching = st.signal && st.lastStatus && Date.now() - st.lastStatus < 15000;
  st.resumeTimer = setTimeout(async () => {
    if (document.hidden && st.signal) { scheduleResume(); return; }
    if (await resumeOnce()) scheduleResume();
  }, watching ? 60000 : 15000);
}

function showAccount() {
  $('acct').classList.remove('hidden');
  $('acctName').textContent = st.acct?.name || st.acct?.email || 'เข้าสู่ระบบแล้ว';
  $('acctName').title = st.acct?.email || '';
}
function hideAccount() { $('acct').classList.add('hidden'); }

async function logout() {
  const a = st.acct;
  acctClear();
  st.acct = null;
  clearTimeout(st.resumeTimer);
  if (a) st.lobby?.request({ t: 'logout', card: a.card });
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch {}
  setTimeout(() => location.reload(), 400);
}

// ---------- หน้าเข้าสู่ระบบ ----------
const gate = { clientId: '', cred: '', sub: '', email: '', pick: '', busy: false };

async function showGate() {
  loader.skip();
  setLive(false);
  overlay('🔐', 'เข้าสู่ระบบเพื่อดูไลฟ์', 'ยืนยันด้วย Google แล้วกรอกไอดี/รหัสเกมของคุณ');
  $('connLabel').textContent = 'ยังไม่ได้เข้าสู่ระบบ';
  $('gate').classList.remove('hidden');
  gateStep(1);
  gateMsg('กำลังติดต่อผู้ไลฟ์…');
  const hello = await st.lobby.request({ t: 'hello' });
  if (!hello) { gateMsg('ติดต่อผู้ไลฟ์ไม่ได้ — โปรแกรมของผู้ไลฟ์อาจปิดอยู่ ลองรีเฟรชหน้านี้ภายหลัง', true); return; }
  const cid = typeof hello.clientId === 'string' ? hello.clientId : '';
  if (!hello.ok || !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(cid)) {
    gateMsg(REASON_LOGIN.disabled, true);
    return;
  }
  gate.clientId = cid;
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

// อ่าน sub/email จาก ID token เพื่อแสดงผลเท่านั้น — ตัวตรวจลายเซ็นจริงคือโปรแกรมผู้ไลฟ์
function jwtClaims(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(part + '='.repeat((4 - part.length % 4) % 4));
    return safeJson(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))), 8192);
  } catch { return null; }
}

function onGoogle(resp) {
  const c = jwtClaims(resp?.credential);
  if (!c || typeof c.sub !== 'string' || !c.sub) { gateMsg(REASON_LOGIN.google, true); return; }
  gate.cred = resp.credential;
  gate.sub = c.sub;
  gate.email = cleanText(c.email, 120, { singleLine: true });
  gate.pick = '';
  $('gEmail').textContent = gate.email || 'บัญชี Google';
  gateStep(2);
  gateMsg('');
  $('gUser').focus();
}

function gateStep(n) {
  $('gStep1').classList.toggle('done', n > 1);
  $('gStep2').classList.toggle('locked', n < 2);
  $('gSigned').classList.toggle('hidden', n < 2);
  $('gBtnWrap').classList.toggle('hidden', n >= 2);
  for (const id of ['gUser', 'gPass', 'gSubmit']) $(id).disabled = n < 2;
  $('gChoose').replaceChildren();
}

function gateMsg(text, isErr = false) {
  const el = $('gMsg');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

async function gateSubmit(ev) {
  ev.preventDefault();
  if (gate.busy || !gate.cred) return;
  const u = $('gUser').value.trim();
  const p = $('gPass').value;
  if (!u || !p) { gateMsg('กรอกไอดีและรหัสผ่านให้ครบ', true); return; }
  gate.busy = true;
  $('gSubmit').disabled = true;
  gateMsg('กำลังตรวจสอบ…');
  const req = { t: 'login', gid: gate.cred, u: u.slice(0, 200), p: p.slice(0, 200) };
  if (gate.pick) req.pick = gate.pick;
  const r = await st.lobby.request(req);
  gate.busy = false;
  $('gSubmit').disabled = false;
  if (!r) { gateMsg('ติดต่อผู้ไลฟ์ไม่ได้ ลองใหม่อีกครั้ง', true); return; }
  if (r.ok && /^[A-Za-z0-9_-]{43}$/.test(r.card)) {
    $('gPass').value = '';
    st.acct = { card: r.card, sub: gate.sub, email: gate.email, name: cleanText(r.name, 80, { singleLine: true }) };
    acctSave(st.acct);
    $('gate').classList.add('hidden');
    showAccount();
    applyWatch(r);
    scheduleResume();
    return;
  }
  if (r.reason === 'choose' && Array.isArray(r.options)) { renderChoose(r.options); return; }
  if (r.reason === 'locked') {
    gateMsg(`ลองผิดหลายครั้งเกินไป — รออีก ${Math.ceil(clampInt(r.wait, 1, 86400, 900) / 60)} นาที`, true);
    return;
  }
  if (r.reason === 'google') { gateStep(1); gate.cred = ''; }
  gateMsg(Object.hasOwn(REASON_LOGIN, r.reason) ? REASON_LOGIN[r.reason] : 'เข้าสู่ระบบไม่สำเร็จ', true);
}

// ไอดี/รหัสเดียวกันใช้กับลูกค้าหลายรายการที่กำลังไลฟ์ → ให้เลือก (ชื่อกรองก่อนแสดง, ปุ่มสร้างด้วย DOM)
function renderChoose(options) {
  const box = $('gChoose');
  box.replaceChildren();
  gateMsg('ไอดีนี้มีหลายรายการ — เลือกรายการที่ต้องการดู');
  for (const o of options.slice(0, 10)) {
    const id = typeof o?.id === 'string' ? o.id.slice(0, 80) : '';
    if (!id) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gate-choice';
    b.textContent = cleanText(o.name, 80, { singleLine: true }) || id;
    b.addEventListener('click', () => { gate.pick = id; $('gStep2').requestSubmit(); });
    box.appendChild(b);
  }
}

function setupGate() {
  $('gStep2').addEventListener('submit', gateSubmit);
  $('gSwitch').addEventListener('click', () => {
    gate.cred = ''; gate.sub = ''; gate.email = ''; gate.pick = '';
    try { window.google?.accounts?.id?.disableAutoSelect(); } catch {}
    gateStep(1);
    gateMsg('');
  });
  $('gShowPass').addEventListener('click', () => {
    const inp = $('gPass');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('gShowPass').textContent = inp.type === 'password' ? '👁' : '🙈';
  });
  $('logoutBtn').addEventListener('click', logout);
}

function onConnState(s) {
  $('connLabel').textContent = s === 'online' ? 'เชื่อมต่อแล้ว' : s === 'connecting' ? 'กำลังเชื่อมต่อ…' : 'ขาดการเชื่อมต่อ';
  if (s === 'online' && !st.onlineSince) st.onlineSince = Date.now();
  if (s === 'online') loader.step(2);
}

function onSignal(m) {
  if (st.ended) return;
  if (m.t === 'status') {
    st.lastStatus = Date.now();
    const title = cleanText(m.title, 120, { singleLine: true });   // ชื่อหน้าต่างเกม — กรองก่อนแสดงเสมอ
    if (title) { $('streamTitle').textContent = title; document.title = title + ' · Daily Task Live'; }
    if (typeof m.giphy === 'string') updateGiphy(safeGiphyKey(m.giphy));
    setLive(!!m.live);
    if (m.live) {
      if (!st.pc) startPeer();
      else if (st.pc.connectionState === 'connected') overlay(null);
    } else {
      overlay('⏸️', 'พักไลฟ์ชั่วคราว', 'หน้าต่างเกมของผู้ไลฟ์ถูกย่อหรือปิดอยู่ — จะกลับมาเองอัตโนมัติ');
    }
  } else if (m.t === 'end') {
    endStream('🏁', 'ไลฟ์จบแล้ว', 'ขอบคุณที่รับชม — ลิงก์นี้ใช้ไม่ได้อีกแล้ว');
  } else if (m.t === 'answer' && m.to === vid && st.pc) {
    if (typeof m.sdp !== 'string' || m.sdp.length > 100000) return;
    // QoS 0 + หลาย broker อาจทำให้ได้ answer ซ้ำ — รับเฉพาะตอนที่ยังรอ answer อยู่จริง
    if (st.pc.signalingState !== 'have-local-offer') return;
    clearTimeout(st.answerTimer);
    st.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(e => { console.error(e); retryPeer(); });
  } else if (m.t === 'reject' && m.to === vid) {
    if (m.reason === 'ended') endStream('🏁', 'ไลฟ์จบแล้ว', 'ลิงก์นี้ใช้ไม่ได้อีกแล้ว');
    else { overlay('🚫', 'ผู้ชมเต็ม', 'ลองใหม่อีกครั้งภายหลัง'); closePeer(); retryPeer(15000); }
  }
}

function checkStatusTimeout() {
  if (st.ended) return;
  if (!st.lastStatus) {
    // ยังไม่เคยได้ยินผู้ไลฟ์เลย: ไลฟ์ยังไม่เริ่ม / โปรแกรมผู้ไลฟ์ปิดอยู่ / ลิงก์หมดอายุ (ล็อกเอาท์ไปตอนไม่มีใครดู)
    if (!st.noStreamerShown && st.onlineSince && Date.now() - st.onlineSince > NO_STREAMER_MS) {
      st.noStreamerShown = true;
      overlay('📴', 'ยังไม่พบผู้ไลฟ์',
        st.mode === 'lobby' ? 'ผู้ไลฟ์อาจยังไม่เปิดไลฟ์ · หน้านี้จะเชื่อมต่อเองเมื่อไลฟ์เริ่ม'
          : 'ผู้ไลฟ์อาจยังไม่เปิดไลฟ์ หรือลิงก์นี้หมดอายุแล้ว (ลูกค้าล็อกเอาท์ไปแล้ว) · หน้านี้จะเชื่อมต่อเองเมื่อไลฟ์เริ่ม');
    }
    return;
  }
  if (Date.now() - st.lastStatus > STATUS_TIMEOUT_MS) {
    setLive(false);
    overlay('📴', 'ผู้ไลฟ์ออฟไลน์', 'รอสัญญาณ… หน้านี้จะเชื่อมต่อใหม่เองเมื่อไลฟ์กลับมา');
    closePeer();
  }
}

function endStream(icon, title, sub) {
  st.ended = true;
  setLive(false);
  closePeer();
  st.signal?.stop();
  if (st.mode === 'lobby') {
    // เข้าสู่ระบบไว้: ไลฟ์รอบนี้จบ แต่บัตรยังใช้ได้ → รอรอบถัดไป (resume จะได้ token ใหม่เอง)
    st.signal = null;
    st.curToken = '';
    overlay('🌙', 'ไลฟ์รอบนี้จบแล้ว', 'ขอบคุณที่รับชม · หน้านี้จะเชื่อมต่อให้เองเมื่อเริ่มไลฟ์รอบถัดไป');
    setComposer(false);
    $('connLabel').textContent = 'รอไลฟ์รอบถัดไป';
    scheduleResume();
    return;
  }
  overlay(icon, title, sub);
  setComposer(false);
  $('connLabel').textContent = 'จบไลฟ์';
}

// ---------- WebRTC ----------
async function startPeer() {
  closePeer();
  loader.step(3);
  overlay('📡', 'กำลังเปิดไลฟ์…', 'กำลังเชื่อมต่อกับผู้ไลฟ์');
  const pc = new RTCPeerConnection({ iceServers: ICE });
  st.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const dc = pc.createDataChannel('ctl', { ordered: true });
  st.dc = dc;
  dc.bufferedAmountLowThreshold = 256 * 1024;
  dc.onopen = () => { sendCtl({ t: 'quality', q: st.quality, fps: st.fps }); setComposer(true); };
  dc.onclose = () => setComposer(false);
  dc.onmessage = e => onCtl(e.data);

  pc.ontrack = e => {
    if (e.track.kind === 'video') waitFirstFrame();
    const ms = video.srcObject instanceof MediaStream ? video.srcObject : new MediaStream();
    ms.addTrack(e.track);
    video.srcObject = ms;
    video.play().catch(() => {});
    updateUnmuteHint();
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (pc !== st.pc) return;
    if (s === 'connected') { loader.step(4); if (st.live) overlay(null); }
    else if (s === 'failed' || s === 'closed') retryPeer();
    else if (s === 'disconnected') setTimeout(() => { if (pc === st.pc && pc.connectionState === 'disconnected') retryPeer(); }, 5000);
  };

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceComplete(pc, 3000);
    if (pc !== st.pc) return;
    await st.signal.send({ t: 'offer', vid, sdp: pc.localDescription.sdp, q: st.quality, fps: st.fps });
    clearTimeout(st.answerTimer);
    st.answerTimer = setTimeout(() => { if (pc === st.pc && !pc.currentRemoteDescription) retryPeer(); }, 10000);
  } catch (e) {
    console.error(e);
    retryPeer();
  }
}

// ภาพเฟรมแรกขึ้นจอจริง → ปิดหน้าโหลด
function waitFirstFrame() {
  if (loader.closed) return;
  const finish = () => loader.done();   // เรียกซ้ำได้ (ปิดครั้งเดียว)
  // rVFC ไม่ยิงเมื่อหน้าไม่ได้แสดงผล (แท็บพื้นหลัง) → ฟัง loadeddata/playing ด้วย อันไหนมาก่อนก็ปิด
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(finish);
  video.addEventListener('loadeddata', finish, { once: true });
  video.addEventListener('playing', finish, { once: true });
}

function waitIceComplete(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(res => {
    const t = setTimeout(res, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
    });
  });
}

function closePeer() {
  clearTimeout(st.answerTimer);
  if (st.dc) { try { st.dc.close(); } catch {} st.dc = null; }
  if (st.pc) { try { st.pc.close(); } catch {} st.pc = null; }
  if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  setComposer(false);
  $('stats').textContent = '';
}

function retryPeer(delay = 3000) {
  closePeer();
  clearTimeout(st.retryTimer);
  if (st.ended) return;
  st.retryTimer = setTimeout(() => { if (st.live && !st.ended) startPeer(); }, delay);
}

// ---------- DataChannel ----------
function sendCtl(obj) {
  if (!st.dc || st.dc.readyState !== 'open') return false;
  st.dc.send(JSON.stringify(obj));
  return true;
}

const pendingAcks = new Map(); // id -> element
function onCtl(raw) {
  const m = safeJson(raw, 16 * 1024);
  if (!m) return;
  if (m.t === 'info') {
    const w = clampInt(m.w, 0, 8192, 0), h = clampInt(m.h, 0, 8192, 0);
    if (w && h) $('stats').dataset.size = `${w}×${h}`;
    renderFpsOptions(m);
  } else if (m.t === 'ack') {
    const el = pendingAcks.get(String(m.id || ''));
    if (el) { el.classList.add('acked'); pendingAcks.delete(m.id); }
  } else if (m.t === 'rate') {
    toast(`ส่งเร็วเกินไป รออีก ${Math.ceil(clampInt(m.wait, 1, 600000, 1000) / 1000)} วินาที`);
  } else if (m.t === 'error') {
    const why = Object.hasOwn(REASON_TEXT, m.reason) ? REASON_TEXT[m.reason] : 'ส่งไม่สำเร็จ';
    toast(why);
  }
}

function canSend() {
  if (!st.dc || st.dc.readyState !== 'open') { toast('ยังไม่ได้เชื่อมต่อไลฟ์'); return false; }
  const wait = st.lastSend + SEND_GAP_MS - Date.now();
  if (wait > 0) { toast('ส่งเร็วเกินไป รอสักครู่'); return false; }
  st.lastSend = Date.now();
  return true;
}

function logItem(node) {
  const log = $('chatLog');
  const row = document.createElement('div');
  row.className = 'msg';
  row.appendChild(node);
  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.textContent = '✓';
  row.appendChild(tick);
  log.appendChild(row);
  while (log.children.length > 60) log.removeChild(log.children[1]);
  log.scrollTop = log.scrollHeight;
  return row;
}

function sendText(raw) {
  const text = cleanText(raw, 500);   // ลบอักขระควบคุม/กลับทิศ/แท็ก HTML/javascript: ก่อนส่ง
  if (!text) { if (raw.trim()) toast('ข้อความนี้มีแต่อักขระที่ไม่อนุญาต จึงไม่ส่ง'); return !!raw.trim(); }
  if (!canSend()) return false;
  const id = rid();
  sendCtl({ t: 'chat', id, text });
  const span = document.createElement('span');
  span.className = 'msg-text';
  span.textContent = text;
  pendingAcks.set(id, logItem(span));
  return true;
}

function sendGif(rawUrl, rawW, rawH, rawPreview) {
  const url = safeGiphyUrl(rawUrl);
  if (!url) { toast('GIF นี้มาจากแหล่งที่ไม่อนุญาต'); return; }
  const preview = safeGiphyUrl(rawPreview) || url;
  if (!canSend()) return;
  const id = rid();
  sendCtl({ t: 'gif', id, url, w: clampInt(rawW, 1, 4096, 200), h: clampInt(rawH, 1, 4096, 200) });
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = preview;
  img.alt = 'GIF';
  pendingAcks.set(id, logItem(img));
  closePicker();
}

async function sendFile(file, kind, name = 'image') {
  if (!st.dc || st.dc.readyState !== 'open') { toast('ยังไม่ได้เชื่อมต่อไลฟ์'); return; }
  // ตรวจไบต์จริง + สแกนโค้ดฝัง + จำกัดขนาด + วาดใหม่ลบข้อมูลแฝง (GIF คงไฟล์เดิม)
  const safe = await sanitizeImageFile(file);
  if (!safe.ok) { toast(REASON_TEXT[safe.reason] || 'ส่งไม่สำเร็จ'); return; }
  if (safe.mime === 'image/gif' && kind === 'image') kind = 'gif';
  const blob = safe.blob;
  if (!canSend()) return;
  const id = rid();
  const dc = st.dc;
  const cleanName = cleanText(String(name), 80, { singleLine: true }).replace(/[\\/:*?"<>|]/g, '_') || 'image';
  sendCtl({ t: 'file-start', id, kind, mime: safe.mime, size: blob.size, name: cleanName });
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = URL.createObjectURL(blob);
  img.alt = kind;
  const row = logItem(img);
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
  sendCtl({ t: 'file-end', id });
  row.classList.remove('sending');
  closePicker();
}

// ตัวเลือก fps มาจากผู้ไลฟ์ (fpsOptions ไม่เกิน Hz จอของผู้ไลฟ์) — ผู้ไลฟ์รุ่นเก่าไม่ส่งมา = ซ่อนไว้
function renderFpsOptions(m) {
  const sel = $('fps');
  const opts = Array.isArray(m.fpsOptions) ? m.fpsOptions.slice(0, 20).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 1000) : [];
  if (!opts.length) { sel.classList.add('hidden'); return; }
  const cur = clampInt(m.fps, 1, 1000, st.fps);
  if (sel.dataset.opts !== opts.join(',')) {
    sel.replaceChildren(...opts.map(n => {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = n + ' fps';
      return o;
    }));
    sel.dataset.opts = opts.join(',');
  }
  sel.value = String(opts.includes(cur) ? cur : opts[opts.length - 1]);
  sel.title = `เฟรมต่อวินาที (สูงสุด ${clampInt(m.maxFps, 1, 1000, opts[opts.length - 1])} fps ตาม Hz จอของผู้ไลฟ์)`;
  sel.classList.remove('hidden');
}

// ---------- controls ----------
function setupControls() {
  const vol = Number(lsGet('dt_vol', '80'));
  $('volume').value = vol;
  video.volume = vol / 100;
  $('volVal').textContent = vol + '%';
  $('quality').value = st.quality;

  $('volume').addEventListener('input', e => {
    const v = Number(e.target.value);
    video.volume = v / 100;
    $('volVal').textContent = v + '%';
    lsSet('dt_vol', String(v));
    if (v > 0 && video.muted) setMuted(false);
  });
  $('muteBtn').addEventListener('click', () => setMuted(!video.muted));
  $('unmuteBtn').addEventListener('click', () => setMuted(false));
  $('quality').addEventListener('change', e => {
    st.quality = e.target.value;
    lsSet('dt_quality', st.quality);
    sendCtl({ t: 'quality', q: st.quality });
    toast('เปลี่ยนคุณภาพเป็น ' + e.target.selectedOptions[0].textContent);
  });
  $('fps').addEventListener('change', e => {
    st.fps = Number(e.target.value) || 30;
    lsSet('dt_fps', String(st.fps));
    sendCtl({ t: 'quality', fps: st.fps });
    toast('เปลี่ยนเป็น ' + st.fps + ' fps');
  });
  const fs = () => {
    const el = $('stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  };
  $('fsBtn').addEventListener('click', fs);
  video.addEventListener('dblclick', fs);
  setInterval(updateStats, 1000);
  updateMuteUi();
}

function setMuted(m) {
  video.muted = m;
  if (!m) video.play().catch(() => {});
  updateMuteUi();
}

function updateMuteUi() {
  $('muteBtn').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
  updateUnmuteHint();
}

function updateUnmuteHint() {
  $('unmuteBtn').classList.toggle('hidden', !(video.muted && video.srcObject));
}

async function updateStats() {
  const pc = st.pc;
  if (!pc || pc.connectionState !== 'connected') return;
  try {
    const stats = await pc.getStats();
    stats.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameWidth) {
        const fps = r.framesPerSecond ? Math.round(r.framesPerSecond) : '–';
        $('stats').textContent = `${r.frameWidth}×${r.frameHeight} · ${fps}fps`;
      }
    });
  } catch {}
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
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji';
    b.textContent = em;
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
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  grid.replaceChildren(d);
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
    const wrap = document.createElement('div');
    wrap.className = 'mine-item';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(it.blob);
    img.alt = 'sticker';
    img.addEventListener('click', () => sendFile(it.blob, 'sticker', 'sticker'));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '×';
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
