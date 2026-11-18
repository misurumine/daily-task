// Protocol v1 §1–3: token → (topic, AES-GCM key) และซองข้อความเข้ารหัส — ต้องตรงกับฝั่ง Python
const enc = new TextEncoder();
const dec = new TextDecoder();
const SALT = enc.encode('dailytask-live/v1');

export function parseToken(hash) {
  const t = String(hash || '').replace(/^#/, '').trim();
  if (!/^[A-Za-z0-9_-]{22}$/.test(t)) return null;
  const b64 = t.replace(/-/g, '+').replace(/_/g, '/') + '==';
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return raw.length === 16 ? raw : null;
}

async function hkdf(ikm, info, len) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) }, base, len * 8);
  return new Uint8Array(bits);
}

const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

export async function deriveSession(tokenBytes) {
  const topicId = await hkdf(tokenBytes, 'topic', 16);
  const keyRaw = await hkdf(tokenBytes, 'key', 32);
  const key = await crypto.subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const base = 'dtlive/v1/' + hex(topicId);
  return { key, topicS: base + '/s', topicV: base + '/v' };
}

export async function seal(key, topic, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = enc.encode(JSON.stringify({ ...obj, ts: Date.now() }));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(topic) }, key, pt));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return out;
}

export async function open(key, topic, bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 12 + 16) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: u8.subarray(0, 12), additionalData: enc.encode(topic) }, key, u8.subarray(12));
    // ทิ้ง key อันตราย (__proto__ ฯลฯ) และรับเฉพาะ object
    const msg = JSON.parse(dec.decode(pt), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string' || Math.abs(Date.now() - Number(msg.ts)) > 60000) return null;
    return msg;
  } catch {
    return null; // ถอดรหัสไม่ได้ = ไม่ใช่ข้อความของไลฟ์นี้ → ทิ้ง
  }
}
