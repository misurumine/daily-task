// Protocol v1 §3: ช่องสัญญาณ MQTT (เข้ารหัส) — เชื่อมต่อ "ทุก broker พร้อมกัน"
// broker ฟรีบางตัวล่ม/ช้าเป็นช่วง ๆ: ตัวไหนส่ง status มาก่อนก็ใช้ได้ทันที ไม่ต้องรอลองทีละตัว
// ข้อความที่ผู้ชมส่ง (offer/bye) ส่งออกทุกตัวที่ต่ออยู่ — ผู้ไลฟ์ข้าม offer ซ้ำ, ผู้ชมรับ answer ครั้งเดียว (PROTOCOL.md)
import { seal, open } from './crypto.js';

export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://mqtt-dashboard.com:8884/mqtt',   // HiveMQ ตัวเดียวกับ broker.hivemq.com (ชื่อนี้ไม่มี IPv6 จึงต่อได้เร็วกว่า)
  'wss://test.mosquitto.org:8081/mqtt',
];

export class Signal {
  constructor(session, onMessage, onState) {
    this.s = session;
    this.onMessage = onMessage;
    this.onState = onState;
    this.clients = [];
    this.state = null;
  }

  start() {
    this._setState('connecting');
    this.clients = BROKERS.map(url => this._connect(url));
  }

  _connect(url) {
    const c = window.mqtt.connect(url, {
      clientId: 'dtv_' + Math.random().toString(16).slice(2, 12),
      clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 15000,
    });
    c.on('connect', () => {
      c.subscribe(this.s.topicS, { qos: 0 });
      this._updateState();
    });
    c.on('message', async (topic, payload) => {
      if (topic !== this.s.topicS) return;
      const msg = await open(this.s.key, topic, payload);
      if (!msg) return;
      try { this.onMessage(msg); } catch (e) { console.error(e); }
    });
    for (const ev of ['offline', 'close', 'error']) c.on(ev, () => this._updateState());
    return c;
  }

  _updateState() {
    if (this.clients.some(c => c.connected)) this._setState('online');
    else if (this.state === 'online') this._setState('offline');
  }

  _setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.onState(s);
  }

  async send(obj) {
    const live = this.clients.filter(c => c.connected);
    if (!live.length) return false;
    const payload = await seal(this.s.key, this.s.topicV, obj);
    for (const c of live) c.publish(this.s.topicV, payload, { qos: 0, retain: false });
    return true;
  }

  stop() {
    // ปิดแล้วไม่ต้องรายงานสถานะอีก (กัน 'ขาดการเชื่อมต่อ' ทับข้อความของหน้าหลังจบไลฟ์)
    this.onState = () => {};
    this.onMessage = () => {};
    for (const c of this.clients) { try { c.end(true); } catch {} }
    this.clients = [];
  }
}
