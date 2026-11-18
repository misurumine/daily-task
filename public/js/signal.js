// Protocol v1 §3: ช่องสัญญาณ MQTT (เข้ารหัส) — ลอง broker ทีละตัว ถ้าไม่ได้ status ภายใน 8 วิ ย้ายไปตัวถัดไป
import { seal, open } from './crypto.js';

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const STATUS_WAIT_MS = 8000;

export class Signal {
  constructor(session, onMessage, onState) {
    this.s = session;
    this.onMessage = onMessage;
    this.onState = onState;
    this.idx = 0;
    this.client = null;
    this.gotStatus = false;
    this.timer = null;
  }

  start() {
    this._connect();
  }

  _connect() {
    clearTimeout(this.timer);
    if (this.client) { try { this.client.end(true); } catch {} }
    const url = BROKERS[this.idx % BROKERS.length];
    this.onState('connecting');
    const c = window.mqtt.connect(url, {
      clientId: 'dtv_' + Math.random().toString(16).slice(2, 12),
      clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 8000,
    });
    this.client = c;
    c.on('connect', () => {
      this.onState('online');
      c.subscribe(this.s.topicS, { qos: 0 });
      this._armFailover();
    });
    c.on('message', async (topic, payload) => {
      if (topic !== this.s.topicS) return;
      const msg = await open(this.s.key, topic, payload);
      if (!msg) return;
      if (msg.t === 'status' || msg.t === 'end') { this.gotStatus = true; clearTimeout(this.timer); }
      try { this.onMessage(msg); } catch (e) { console.error(e); }
    });
    c.on('offline', () => this.onState('offline'));
    c.on('error', () => this.onState('offline'));
  }

  _armFailover() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.gotStatus) { this.idx++; this._connect(); }
    }, STATUS_WAIT_MS);
  }

  async send(obj) {
    if (!this.client || !this.client.connected) return false;
    const payload = await seal(this.s.key, this.s.topicV, obj);
    this.client.publish(this.s.topicV, payload, { qos: 0, retain: false });
    return true;
  }

  stop() {
    clearTimeout(this.timer);
    if (this.client) { try { this.client.end(true); } catch {} }
  }
}
