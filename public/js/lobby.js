// Protocol §7: ประตูเข้าสู่ระบบ (lobby) — คุยกับโปรแกรมผู้ไลฟ์ผ่าน MQTT แบบเข้ารหัสด้วยกุญแจร้าน
// ทุกคำขอใช้กุญแจชั่วคราวใหม่ (ECDH P-256) → broker/คนอื่นเห็นแค่ข้อมูลที่เข้ารหัสแล้ว และคำตอบมีแต่ร้านตัวจริงที่สร้างได้
import { SHOP_KEY } from './lobby-config.js?v=1';
import { BROKERS } from './signal.js?v=3';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SALT = enc.encode('dailytask-lobby/v1');
const REPLY_TIMEOUT_MS = 12000;

const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
function unb64u(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
}
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };

async function hkdfKey(ikm, info, usage) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info },
    base, { name: 'AES-GCM', length: 256 }, false, usage);
}

const safeParse = text => JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));

export class Lobby {
  constructor() {
    this.clients = [];
    this.waiters = new Map();   // topicR -> {key, resolve}
    this.ready = this._init();
  }

  async _init() {
    this.shopRaw = unb64u(SHOP_KEY);
    this.shopKey = await crypto.subtle.importKey('raw', this.shopRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const id = new Uint8Array(await crypto.subtle.digest('SHA-256', this.shopRaw)).subarray(0, 16);
    const base = 'dtlobby/v1/' + hex(id);
    this.topicQ = base + '/q';
    this.topicR = base + '/r/';
    this.clients = BROKERS.map(url => this._connect(url));
  }

  _connect(url) {
    const c = window.mqtt.connect(url, {
      clientId: 'dtl_' + Math.random().toString(16).slice(2, 12),
      clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 15000,
    });
    c.on('connect', () => { for (const t of this.waiters.keys()) c.subscribe(t, { qos: 0 }); });
    c.on('message', (topic, payload) => this._onMessage(topic, payload));
    return c;
  }

  async _onMessage(topic, payload) {
    const w = this.waiters.get(topic);
    if (!w) return;
    try {
      const u8 = new Uint8Array(payload);
      if (u8.length < 12 + 16 || u8.length > 16384) return;
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: u8.subarray(0, 12), additionalData: enc.encode(topic) }, w.key, u8.subarray(12));
      const msg = safeParse(dec.decode(pt));
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.t !== w.t) return;
      if (Math.abs(Date.now() - Number(msg.ts)) > 60000) return;
      if (this.waiters.get(topic) === w) { this.waiters.delete(topic); w.resolve(msg); }
    } catch { /* ไม่ใช่คำตอบของร้าน → ทิ้ง */ }
  }

  // รอจนต่อ broker ได้อย่างน้อยตัวหนึ่ง (ไม่เกิน ms)
  async _connected(ms = 15000) {
    const until = Date.now() + ms;
    while (!this.clients.some(c => c.connected)) {
      if (Date.now() > until) return false;
      await new Promise(r => setTimeout(r, 200));
    }
    return true;
  }

  /** ส่งคำขอ แล้วรอคำตอบ — คืน object หรือ null (ร้านไม่ตอบ / ออฟไลน์) */
  async request(obj) {
    await this.ready;
    if (!(await this._connected())) return null;
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: this.shopKey }, eph.privateKey, 256));
    const kq = await hkdfKey(shared, concat(enc.encode('q'), ephRaw), ['encrypt']);
    const kr = await hkdfKey(shared, concat(enc.encode('r'), ephRaw), ['decrypt']);
    const rid = hex(crypto.getRandomValues(new Uint8Array(16)));
    const topicR = this.topicR + rid;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = enc.encode(JSON.stringify({ ...obj, rid, ts: Date.now() }));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(this.topicQ) }, kq, pt));
    const payload = new Uint8Array(1 + 65 + 12 + ct.length);
    payload[0] = 1; payload.set(ephRaw, 1); payload.set(iv, 66); payload.set(ct, 78);

    const reply = new Promise(resolve => this.waiters.set(topicR, { key: kr, t: obj.t, resolve }));
    const live = this.clients.filter(c => c.connected);
    // subscribe คำตอบก่อนส่งคำขอ (ร้านตอบเร็วมาก) — รอ suback ทุกตัวที่ต่ออยู่
    await Promise.all(live.map(c => new Promise(res => c.subscribe(topicR, { qos: 0 }, () => res()))));
    for (const c of live) c.publish(this.topicQ, payload, { qos: 0, retain: false });
    const timer = new Promise(res => setTimeout(() => res(null), REPLY_TIMEOUT_MS));
    const out = await Promise.race([reply, timer]);
    this.waiters.delete(topicR);
    for (const c of this.clients) { try { c.unsubscribe(topicR); } catch {} }
    return out;
  }

  stop() {
    for (const c of this.clients) { try { c.end(true); } catch {} }
    this.clients = [];
  }
}
