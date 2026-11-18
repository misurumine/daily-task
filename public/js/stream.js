// ช่องดูไลฟ์ 1 ช่อง = 1 เกม (Protocol v1 ข้อ 1–5) — หน้าเว็บเปิดได้หลายช่องพร้อมกัน แต่ละช่องมีเสียง/คุณภาพ/fps ของตัวเอง
import { deriveSession, parseToken } from './crypto.js?v=2';
import { Signal } from './signal.js?v=3';
import { cleanText, safeJson, safeGiphyKey, clampInt } from './security.js?v=1';

const WHO_RE = /^[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{43}$/;

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];
const STATUS_TIMEOUT_MS = 12000;
// ต่อ broker ได้แล้วแต่ยังไม่เคยได้ status เลยนานเท่านี้ → บอกผู้ชมว่ายังไม่พบผู้ไลฟ์ (แต่ยังรอต่อ)
const NO_STREAMER_MS = 20000;

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
const hexId = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const QUALITIES = [['source', 'ต้นฉบับ'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']];

export class LiveTile {
  /**
   * @param {object} o  id (รหัสเกม/'link'), name (ชื่อที่แสดง), mode ('link' | 'lobby'), closable
   * @param {object} hooks  onStatus(tile, msg), onCtl(tile, msg), onState(tile), onStep(tile, n), onFirstFrame(tile),
   *                        onClose(tile), onExpand(tile), toast(text)
   */
  constructor(o, hooks) {
    this.id = o.id;
    this.name = o.name || '';
    this.mode = o.mode || 'link';
    this.hooks = hooks;
    this.vid = hexId(8);
    this.token = '';
    Object.assign(this, {
      signal: null, pc: null, dc: null, live: false, ended: false, lastStatus: 0, onlineSince: 0,
      noStreamerShown: false, retryTimer: null, answerTimer: null, title: '', firstFrame: false,
      quality: lsGet('dt_quality', 'source'),
      fps: Number(lsGet('dt_fps', '30')) || 30,
    });
    this._build(o.closable);
    this._timers = [setInterval(() => this._checkStatus(), 2000), setInterval(() => this._updateStats(), 1000)];
    this.setOverlay('⏳', 'กำลังเชื่อมต่อ…', 'รอสัญญาณจากผู้ไลฟ์');
  }

  // ---------- DOM ----------
  _build(closable) {
    const root = this.el = el('div', 'tile');
    const v = this.video = el('video');
    v.playsInline = true; v.autoplay = true; v.muted = true;
    const ov = this.ov = el('div', 'overlay');
    this.ovIcon = el('div', 'overlay-icon');
    this.ovTitle = el('div', 'overlay-title');
    this.ovSub = el('div', 'overlay-sub');
    ov.append(this.ovIcon, this.ovTitle, this.ovSub);

    const head = el('div', 'tile-head');
    this.badge = el('span', 'live-badge');
    this.badge.append(el('span', 'live-dot'), document.createTextNode('LIVE'));
    this.nameEl = el('span', 'tile-name', this.name);
    head.append(this.badge, this.nameEl);

    this.unmuteBtn = el('button', 'unmute-btn hidden', '🔊 แตะเพื่อเปิดเสียง');
    this.unmuteBtn.type = 'button';

    const c = el('div', 'controls');
    this.muteBtn = this._btn('🔇', 'ปิด/เปิดเสียงช่องนี้');
    this.volume = el('input', 'volume');
    Object.assign(this.volume, { type: 'range', min: '0', max: '100', step: '1' });
    this.volume.setAttribute('aria-label', 'ระดับเสียงช่องนี้');
    this.volVal = el('span', 'vol-val');
    this.stats = el('span', 'stats');
    this.qSel = el('select', 'quality');
    this.qSel.setAttribute('aria-label', 'คุณภาพวิดีโอ');
    for (const [val, label] of QUALITIES) { const op = el('option', null, label); op.value = val; this.qSel.appendChild(op); }
    this.fpsSel = el('select', 'quality hidden');
    this.fpsSel.setAttribute('aria-label', 'เฟรมต่อวินาที');
    this.expandBtn = this._btn('⤢', 'ขยายช่องนี้ / กลับไปดูทุกช่อง');
    this.fsBtn = this._btn('⛶', 'เต็มจอ');
    c.append(this.muteBtn, this.volume, this.volVal, el('span', 'spacer'), this.stats, this.qSel, this.fpsSel, this.expandBtn, this.fsBtn);
    if (closable) {
      this.closeBtn = this._btn('✕', 'ปิดช่องนี้');
      c.appendChild(this.closeBtn);
      this.closeBtn.addEventListener('click', () => this.hooks.onClose?.(this));
    }
    root.append(v, ov, head, this.unmuteBtn, c);

    const vol = clampInt(Number(lsGet('dt_vol:' + this.id, lsGet('dt_vol', '80'))), 0, 100, 80);
    this.volume.value = String(vol);
    v.volume = vol / 100;
    this.volVal.textContent = vol + '%';
    this.qSel.value = this.quality;

    this.volume.addEventListener('input', () => {
      const n = Number(this.volume.value);
      v.volume = n / 100;
      this.volVal.textContent = n + '%';
      lsSet('dt_vol:' + this.id, String(n));
      if (n > 0 && v.muted) this.setMuted(false);
      this._muteUi();
    });
    this.muteBtn.addEventListener('click', () => this.setMuted(!v.muted));
    this.unmuteBtn.addEventListener('click', () => this.setMuted(false));
    this.qSel.addEventListener('change', () => {
      this.quality = this.qSel.value;
      lsSet('dt_quality', this.quality);
      this.sendCtl({ t: 'quality', q: this.quality });
      this.hooks.toast?.(`${this.name || 'ไลฟ์'}: คุณภาพ ${this.qSel.selectedOptions[0].textContent}`);
    });
    this.fpsSel.addEventListener('change', () => {
      this.fps = Number(this.fpsSel.value) || 30;
      lsSet('dt_fps', String(this.fps));
      this.sendCtl({ t: 'quality', fps: this.fps });
      this.hooks.toast?.(`${this.name || 'ไลฟ์'}: ${this.fps} fps`);
    });
    this.expandBtn.addEventListener('click', () => this.hooks.onExpand?.(this));
    const fs = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (root.requestFullscreen) root.requestFullscreen();
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    };
    this.fsBtn.addEventListener('click', fs);
    v.addEventListener('dblclick', fs);
    this._muteUi();
  }

  _btn(text, title) {
    const b = el('button', 'ctl-btn', text);
    b.type = 'button';
    b.title = title;
    return b;
  }

  setName(name) {
    this.name = name || '';
    this.nameEl.textContent = this.name;
  }

  setOverlay(icon, title, sub = '') {
    if (!icon) { this.ov.classList.add('hidden'); return; }
    this.ov.classList.remove('hidden');
    this.ovIcon.textContent = icon;
    this.ovTitle.textContent = title;
    this.ovSub.textContent = sub;
  }

  setMuted(m) {
    this.userMuted = m;   // ผู้ชมกดปิดเสียงเอง → ต่อใหม่ก็ไม่เปิดเสียงให้เอง
    this.video.muted = m;
    if (!m) this.video.play().catch(() => { this.video.muted = true; this._muteUi(); });
    this._muteUi();
  }

  _muteUi() {
    const v = this.video;
    this.muteBtn.textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
    this.unmuteBtn.classList.toggle('hidden', !(v.muted && v.srcObject));
  }

  _setLive(on) {
    this.live = on;
    this.badge.classList.toggle('on', on);
    this.hooks.onState?.(this);
  }

  // ---------- เชื่อมต่อ ----------
  /** ต่อไลฟ์ด้วย token (string 22 ตัว หรือ bytes) — เรียกซ้ำได้: ทิ้งการเชื่อมต่อเดิมก่อน */
  async start(token) {
    const bytes = typeof token === 'string' ? parseToken(token) : token;
    if (!bytes) return false;
    this.token = typeof token === 'string' ? token : '';
    this._teardown();
    Object.assign(this, { ended: false, lastStatus: 0, onlineSince: 0, noStreamerShown: false });
    const session = await deriveSession(bytes);
    this.hooks.onStep?.(this, 1);
    this.setOverlay('⏳', 'กำลังเชื่อมต่อ…', 'รอสัญญาณจากผู้ไลฟ์');
    this.signal = new Signal(session, m => this._onSignal(m), s => this._onConn(s));
    this.signal.start();
    return true;
  }

  /** ไม่มีไลฟ์ให้ต่อ (เกมนี้ยังไม่ได้ไลฟ์) — รอ token จากรายการเกม */
  waitOffline() {
    this._teardown();
    this.token = '';
    this._setLive(false);
    this.setOverlay('🌙', 'ยังไม่ได้ไลฟ์', 'จะเชื่อมต่อให้เองเมื่อเริ่มไลฟ์เกมนี้');
  }

  _teardown() {
    this._closePeer();
    clearTimeout(this.retryTimer);
    this.signal?.stop();
    this.signal = null;
  }

  destroy() {
    this.signal?.send({ t: 'bye', vid: this.vid });
    this._timers.forEach(clearInterval);
    this._teardown();
    this.el.remove();
  }

  bye() { this.signal?.send({ t: 'bye', vid: this.vid }); }

  _onConn(s) {
    if (s === 'online' && !this.onlineSince) this.onlineSince = Date.now();
    if (s === 'online') this.hooks.onStep?.(this, 2);
    this.connState = s;
    this.hooks.onState?.(this);
  }

  _onSignal(m) {
    if (this.ended) return;
    if (m.t === 'status') {
      this.lastStatus = Date.now();
      const title = cleanText(m.title, 120, { singleLine: true });   // ชื่อหน้าต่างเกม — กรองก่อนแสดงเสมอ
      if (title) this.title = title;
      if (typeof m.giphy === 'string') m.giphy = safeGiphyKey(m.giphy);
      this._setLive(!!m.live);
      this.hooks.onStatus?.(this, m);
      if (m.live) {
        if (!this.pc) this._startPeer();
        else if (this.pc.connectionState === 'connected') this.setOverlay(null);
      } else {
        this.setOverlay('⏸️', 'พักไลฟ์ชั่วคราว', 'หน้าต่างเกมถูกย่อหรือปิดอยู่ — จะกลับมาเองอัตโนมัติ');
      }
    } else if (m.t === 'end') {
      this._end();
    } else if (m.t === 'answer' && m.to === this.vid && this.pc) {
      if (typeof m.sdp !== 'string' || m.sdp.length > 100000) return;
      // QoS 0 + หลาย broker อาจทำให้ได้ answer ซ้ำ — รับเฉพาะตอนที่ยังรอ answer อยู่จริง
      if (this.pc.signalingState !== 'have-local-offer') return;
      clearTimeout(this.answerTimer);
      this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(e => { console.error(e); this._retry(); });
    } else if (m.t === 'reject' && m.to === this.vid) {
      if (m.reason === 'ended') this._end();
      else { this.setOverlay('🚫', 'ผู้ชมเต็ม', 'ลองใหม่อีกครั้งภายหลัง'); this._closePeer(); this._retry(15000); }
    }
  }

  _end() {
    this.ended = true;
    this._setLive(false);
    this._closePeer();
    this.signal?.stop();
    this.signal = null;
    this.token = '';
    if (this.mode === 'lobby') {
      // เข้าสู่ระบบไว้: ไลฟ์รอบนี้จบ แต่เกมยังอยู่ในรายการ → รอรอบถัดไป (รายการเกมจะให้ token ใหม่เอง)
      this.setOverlay('🌙', 'ไลฟ์รอบนี้จบแล้ว', 'ขอบคุณที่รับชม · จะเชื่อมต่อให้เองเมื่อเริ่มไลฟ์รอบถัดไป');
    } else {
      this.setOverlay('🏁', 'ไลฟ์จบแล้ว', 'ขอบคุณที่รับชม — ลิงก์นี้ใช้ไม่ได้อีกแล้ว');
    }
    this.hooks.onEnd?.(this);
    this.hooks.onState?.(this);
  }

  _checkStatus() {
    if (this.ended || !this.signal) return;
    if (!this.lastStatus) {
      // ยังไม่เคยได้ยินผู้ไลฟ์เลย: ไลฟ์ยังไม่เริ่ม / โปรแกรมผู้ไลฟ์ปิดอยู่ / ลิงก์หมดอายุ
      if (!this.noStreamerShown && this.onlineSince && Date.now() - this.onlineSince > NO_STREAMER_MS) {
        this.noStreamerShown = true;
        this.setOverlay('📴', 'ยังไม่พบผู้ไลฟ์', this.mode === 'lobby'
          ? 'ผู้ไลฟ์อาจยังไม่เปิดไลฟ์ · จะเชื่อมต่อเองเมื่อไลฟ์เริ่ม'
          : 'ผู้ไลฟ์อาจยังไม่เปิดไลฟ์ หรือลิงก์นี้หมดอายุแล้ว (ลูกค้าล็อกเอาท์ไปแล้ว) · หน้านี้จะเชื่อมต่อเองเมื่อไลฟ์เริ่ม');
        this.hooks.onState?.(this);
      }
      return;
    }
    if (Date.now() - this.lastStatus > STATUS_TIMEOUT_MS && (this.live || this.pc)) {
      this._setLive(false);
      this.setOverlay('📴', 'ผู้ไลฟ์ออฟไลน์', 'รอสัญญาณ… จะเชื่อมต่อใหม่เองเมื่อไลฟ์กลับมา');
      this._closePeer();
    }
  }

  // ---------- WebRTC ----------
  async _startPeer() {
    this._closePeer();
    this.hooks.onStep?.(this, 3);
    this.setOverlay('📡', 'กำลังเปิดไลฟ์…', 'กำลังเชื่อมต่อกับผู้ไลฟ์');
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const dc = pc.createDataChannel('ctl', { ordered: true });
    this.dc = dc;
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = () => {
      this.sendCtl({ t: 'quality', q: this.quality, fps: this.fps });
      if (this.who) this.sendCtl({ t: 'who', ticket: this.who });
      this.hooks.onState?.(this);
    };
    dc.onclose = () => this.hooks.onState?.(this);
    dc.onmessage = e => this._onCtl(e.data);

    pc.ontrack = e => {
      if (e.track.kind === 'video') this._waitFirstFrame();
      const v = this.video;
      const ms = v.srcObject instanceof MediaStream ? v.srcObject : new MediaStream();
      ms.addTrack(e.track);
      v.srcObject = ms;
      // เคยกดบนหน้าแล้ว (เช่น ปุ่มดู) → เปิดเสียงได้เลย · เบราว์เซอร์ไม่ยอม → ปิดเสียงไว้ + ปุ่มแตะเพื่อเปิด
      if (navigator.userActivation?.hasBeenActive && v.muted && Number(this.volume.value) > 0 && !this.userMuted) v.muted = false;
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); this._muteUi(); });
      this._muteUi();
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (pc !== this.pc) return;
      if (s === 'connected') { this.hooks.onStep?.(this, 4); if (this.live) this.setOverlay(null); }
      else if (s === 'failed' || s === 'closed') this._retry();
      else if (s === 'disconnected') setTimeout(() => { if (pc === this.pc && pc.connectionState === 'disconnected') this._retry(); }, 5000);
    };

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceComplete(pc, 3000);
      if (pc !== this.pc) return;
      await this.signal.send({ t: 'offer', vid: this.vid, sdp: pc.localDescription.sdp, q: this.quality, fps: this.fps });
      clearTimeout(this.answerTimer);
      this.answerTimer = setTimeout(() => { if (pc === this.pc && !pc.currentRemoteDescription) this._retry(); }, 10000);
    } catch (e) {
      console.error(e);
      this._retry();
    }
  }

  // ภาพเฟรมแรกขึ้นจอจริง → แจ้งหน้าหลัก (ปิดหน้าโหลด)
  _waitFirstFrame() {
    const finish = () => { if (!this.firstFrame) { this.firstFrame = true; this.hooks.onFirstFrame?.(this); } };
    // rVFC ไม่ยิงเมื่อหน้าไม่ได้แสดงผล (แท็บพื้นหลัง) → ฟัง loadeddata/playing ด้วย อันไหนมาก่อนก็ได้
    if ('requestVideoFrameCallback' in this.video) this.video.requestVideoFrameCallback(finish);
    this.video.addEventListener('loadeddata', finish, { once: true });
    this.video.addEventListener('playing', finish, { once: true });
  }

  _closePeer() {
    clearTimeout(this.answerTimer);
    if (this.dc) { try { this.dc.close(); } catch {} this.dc = null; }
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
    const v = this.video;
    if (v && v.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; }
    if (this.stats) this.stats.textContent = '';
    this._muteUi?.();
    this.hooks.onState?.(this);
  }

  _retry(delay = 3000) {
    this._closePeer();
    clearTimeout(this.retryTimer);
    if (this.ended) return;
    this.retryTimer = setTimeout(() => { if (this.live && !this.ended) this._startPeer(); }, delay);
  }

  // ---------- DataChannel ----------
  get open() { return !!this.dc && this.dc.readyState === 'open'; }

  /** บัตรชื่อผู้ชม (ร้านเซ็นให้ ผูกกับไลฟ์รอบนั้น) — ชื่อ Google + Verify/Unverify บนป๊อปอัปแชต · ไม่มี = Guest */
  setWho(ticket) {
    const t = typeof ticket === 'string' && WHO_RE.test(ticket) ? ticket : '';
    if (t === (this.who || '')) return;
    this.who = t;
    if (t) this.sendCtl({ t: 'who', ticket: t });
  }

  sendCtl(obj) {
    if (!this.open) return false;
    this.dc.send(JSON.stringify(obj));
    return true;
  }

  _onCtl(raw) {
    const m = safeJson(raw, 16 * 1024);
    if (!m) return;
    if (m.t === 'info') this._renderFps(m);
    this.hooks.onCtl?.(this, m);
  }

  // ตัวเลือก fps มาจากผู้ไลฟ์ (fpsOptions ไม่เกิน Hz จอของผู้ไลฟ์) — ผู้ไลฟ์รุ่นเก่าไม่ส่งมา = ซ่อนไว้
  _renderFps(m) {
    const sel = this.fpsSel;
    const opts = Array.isArray(m.fpsOptions) ? m.fpsOptions.slice(0, 20).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 1000) : [];
    if (!opts.length) { sel.classList.add('hidden'); return; }
    const cur = clampInt(m.fps, 1, 1000, this.fps);
    if (sel.dataset.opts !== opts.join(',')) {
      sel.replaceChildren(...opts.map(n => { const o = el('option', null, n + ' fps'); o.value = String(n); return o; }));
      sel.dataset.opts = opts.join(',');
    }
    sel.value = String(opts.includes(cur) ? cur : opts[opts.length - 1]);
    sel.title = `เฟรมต่อวินาที (สูงสุด ${clampInt(m.maxFps, 1, 1000, opts[opts.length - 1])} fps ตาม Hz จอของผู้ไลฟ์)`;
    sel.classList.remove('hidden');
  }

  async _updateStats() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;
    try {
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameWidth) {
          const fps = r.framesPerSecond ? Math.round(r.framesPerSecond) : '–';
          this.stats.textContent = `${r.frameWidth}×${r.frameHeight} · ${fps}fps`;
        }
      });
    } catch {}
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
