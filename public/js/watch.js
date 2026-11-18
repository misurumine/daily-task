// หน้าดูไลฟ์ (ผู้ชม) — Protocol v1 (ดู PROTOCOL.md)
import { parseToken, deriveSession } from './crypto.js';
import { Signal } from './signal.js';

const $ = id => document.getElementById(id);
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];
const MAX_FILE = 5 * 1024 * 1024;
const CHUNK = 12 * 1024;
const OK_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const SEND_GAP_MS = 700;
const STATUS_TIMEOUT_MS = 12000;

const vid = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
const video = $('video');

const st = {
  signal: null, pc: null, dc: null, live: false, ended: false,
  lastStatus: 0, giphyKey: '', retryTimer: null, answerTimer: null, lastSend: 0,
  quality: lsGet('dt_quality', 'source'),
};

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
  $('overlayIcon').textContent = icon;
  $('overlayTitle').textContent = title;
  $('overlaySub').textContent = sub;
}

function setLive(on) {
  st.live = on;
  $('liveDot').classList.toggle('on', on);
}

function setComposer(enabled) {
  for (const id of ['msgInput', 'sendBtn', 'pickerBtn', 'imageBtn']) $(id).disabled = !enabled;
  $('msgInput').placeholder = enabled ? 'พิมพ์ข้อความ…' : 'รอเชื่อมต่อไลฟ์ก่อนจึงจะส่งข้อความได้';
}

// ---------- signaling ----------
async function main() {
  setComposer(false);
  setupControls();
  setupChat();
  const token = parseToken(location.hash);
  if (!token) {
    overlay('🔒', 'ลิงก์ไม่ถูกต้อง', 'กรุณาเปิดลิงก์ดูไลฟ์จากข้อความใน Discord ของคุณ');
    $('connLabel').textContent = 'ลิงก์ไม่ถูกต้อง';
    return;
  }
  if (!window.mqtt || !crypto.subtle) {
    overlay('⚠️', 'เบราว์เซอร์นี้ไม่รองรับ', 'ลองเปิดด้วย Chrome, Edge หรือ Safari เวอร์ชันล่าสุด');
    return;
  }
  // ซ่อน token ออกจากแถบที่อยู่ (ยังอยู่ในหน่วยความจำ) — กันติดภาพหน้าจอ/แชร์ต่อโดยไม่ตั้งใจ
  history.replaceState(null, '', location.pathname);

  const session = await deriveSession(token);
  overlay('⏳', 'กำลังเชื่อมต่อ…', 'รอสัญญาณจากผู้ไลฟ์');
  st.signal = new Signal(session, onSignal, onConnState);
  st.signal.start();
  setInterval(checkStatusTimeout, 2000);
  window.addEventListener('pagehide', () => { st.signal?.send({ t: 'bye', vid }); });
}

function onConnState(s) {
  $('connLabel').textContent = s === 'online' ? 'เชื่อมต่อแล้ว' : s === 'connecting' ? 'กำลังเชื่อมต่อ…' : 'ขาดการเชื่อมต่อ';
}

function onSignal(m) {
  if (st.ended) return;
  if (m.t === 'status') {
    st.lastStatus = Date.now();
    if (typeof m.title === 'string' && m.title) $('streamTitle').textContent = m.title;
    if (typeof m.giphy === 'string') updateGiphy(m.giphy);
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
  if (st.ended || !st.lastStatus) return;
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
  overlay(icon, title, sub);
  setComposer(false);
  $('connLabel').textContent = 'จบไลฟ์';
}

// ---------- WebRTC ----------
async function startPeer() {
  closePeer();
  overlay('📡', 'กำลังเปิดไลฟ์…', 'กำลังเชื่อมต่อกับผู้ไลฟ์');
  const pc = new RTCPeerConnection({ iceServers: ICE });
  st.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const dc = pc.createDataChannel('ctl', { ordered: true });
  st.dc = dc;
  dc.bufferedAmountLowThreshold = 256 * 1024;
  dc.onopen = () => { sendCtl({ t: 'quality', q: st.quality }); setComposer(true); };
  dc.onclose = () => setComposer(false);
  dc.onmessage = e => onCtl(e.data);

  pc.ontrack = e => {
    const ms = video.srcObject instanceof MediaStream ? video.srcObject : new MediaStream();
    ms.addTrack(e.track);
    video.srcObject = ms;
    video.play().catch(() => {});
    updateUnmuteHint();
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (pc !== st.pc) return;
    if (s === 'connected') { if (st.live) overlay(null); }
    else if (s === 'failed' || s === 'closed') retryPeer();
    else if (s === 'disconnected') setTimeout(() => { if (pc === st.pc && pc.connectionState === 'disconnected') retryPeer(); }, 5000);
  };

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceComplete(pc, 3000);
    if (pc !== st.pc) return;
    await st.signal.send({ t: 'offer', vid, sdp: pc.localDescription.sdp, q: st.quality });
    clearTimeout(st.answerTimer);
    st.answerTimer = setTimeout(() => { if (pc === st.pc && !pc.currentRemoteDescription) retryPeer(); }, 10000);
  } catch (e) {
    console.error(e);
    retryPeer();
  }
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
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === 'info') {
    if (m.w && m.h) $('stats').dataset.size = `${m.w}×${m.h}`;
  } else if (m.t === 'ack') {
    const el = pendingAcks.get(m.id);
    if (el) { el.classList.add('acked'); pendingAcks.delete(m.id); }
  } else if (m.t === 'rate') {
    toast(`ส่งเร็วเกินไป รออีก ${Math.ceil((m.wait || 1000) / 1000)} วินาที`);
  } else if (m.t === 'error') {
    const why = { too_large: 'ไฟล์ใหญ่เกิน 5 MB', bad_type: 'ไฟล์นี้ไม่ใช่รูปที่รองรับ' }[m.reason] || 'ส่งไม่สำเร็จ';
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

function sendText(text) {
  text = text.trim().slice(0, 500);
  if (!text || !canSend()) return false;
  const id = rid();
  sendCtl({ t: 'chat', id, text });
  const span = document.createElement('span');
  span.className = 'msg-text';
  span.textContent = text;
  pendingAcks.set(id, logItem(span));
  return true;
}

function sendGif(url, w, h, previewUrl) {
  if (!canSend()) return;
  const id = rid();
  sendCtl({ t: 'gif', id, url, w, h });
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = previewUrl || url;
  img.alt = 'GIF';
  pendingAcks.set(id, logItem(img));
  closePicker();
}

async function sendFile(blob, kind, name = 'image') {
  if (!OK_MIME.includes(blob.type)) { toast('รองรับเฉพาะ PNG, JPG, GIF, WEBP'); return; }
  if (blob.size > MAX_FILE) { toast('ไฟล์ใหญ่เกิน 5 MB'); return; }
  if (!canSend()) return;
  const id = rid();
  const dc = st.dc;
  sendCtl({ t: 'file-start', id, kind, mime: blob.type, size: blob.size, name: String(name).slice(0, 80) });
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
    await stickerDb('put', { id: rid() + Date.now().toString(36), blob: f, added: Date.now() });
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

async function loadPack() {
  const grid = $('packGrid');
  try {
    const r = await fetch('./stickers/index.json', { cache: 'no-cache' });
    const list = r.ok ? await r.json() : [];
    if (!Array.isArray(list) || !list.length) {
      grid.innerHTML = '<div class="empty">ยังไม่มีสติกเกอร์ชุดของร้าน</div>';
      return;
    }
    for (const item of list) {
      const file = typeof item === 'string' ? item : item.file;
      if (!file || !/^[\w.\-]+\.(png|jpe?g|gif|webp)$/i.test(file)) continue;
      const img = document.createElement('img');
      img.src = './stickers/' + file;
      img.alt = (item && item.name) || file;
      img.title = img.alt;
      img.loading = 'lazy';
      img.addEventListener('click', async () => {
        const blob = await (await fetch(img.src)).blob();
        sendFile(blob, 'sticker', file);
      });
      grid.appendChild(img);
    }
  } catch {
    grid.innerHTML = '<div class="empty">โหลดสติกเกอร์ไม่สำเร็จ</div>';
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
  grid.innerHTML = '';
  const items = (await stickerDb('all')) || [];
  if (!items.length) {
    grid.innerHTML = '<div class="empty">กด ＋ เพิ่ม เพื่อใส่รูปของคุณเป็นสติกเกอร์</div>';
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
  if (!st.giphyKey) $('gifGrid').innerHTML = '<div class="empty">ค้นหา GIF ยังไม่เปิดใช้ — อัปโหลดไฟล์ GIF ของคุณเองได้</div>';
}

let gifReq = 0;
async function loadGifs(q) {
  if (!st.giphyKey) return;
  const my = ++gifReq;
  const grid = $('gifGrid');
  const base = 'https://api.giphy.com/v1/gifs/';
  const params = new URLSearchParams({ api_key: st.giphyKey, limit: '24', rating: 'pg-13' });
  let url = base + 'trending?' + params;
  if (q && q.trim()) { params.set('q', q.trim()); url = base + 'search?' + params; }
  try {
    const r = await fetch(url);
    if (my !== gifReq) return;
    if (!r.ok) { grid.innerHTML = '<div class="empty">ค้นหา GIF ไม่สำเร็จ (อาจเกินโควตาชั่วคราว)</div>'; return; }
    const data = (await r.json()).data || [];
    grid.innerHTML = '';
    for (const g of data) {
      const send = g.images && (g.images.fixed_height || g.images.downsized);
      const prev = g.images && (g.images.fixed_height_small || send);
      if (!send || !/^https:\/\/media\d*\.giphy\.com\//.test(send.url)) continue;
      const img = document.createElement('img');
      img.src = prev.url;
      img.alt = g.title || 'GIF';
      img.loading = 'lazy';
      img.addEventListener('click', () => sendGif(send.url, Number(send.width), Number(send.height), prev.url));
      grid.appendChild(img);
    }
    if (!grid.children.length) grid.innerHTML = '<div class="empty">ไม่พบ GIF</div>';
  } catch {
    grid.innerHTML = '<div class="empty">ค้นหา GIF ไม่สำเร็จ</div>';
  }
}

main();
