// security.js — กรองข้อมูลทุกอย่างที่เข้า/ออกหน้าดูไลฟ์ (แนวเดียวกับ RealtimeChat)
// - ข้อความ: ลบอักขระควบคุม/กลับทิศ/ล่องหน, แท็ก HTML, scheme อันตราย (javascript: ฯลฯ), ตัวซ้อนสแปม (zalgo)
// - รูป/สติกเกอร์/GIF: ตรวจไบต์หัวไฟล์ (magic bytes), สแกนโค้ดที่ฝังในไฟล์ (polyglot), จำกัดขนาดภาพ,
//   รูปนิ่งวาดใหม่ผ่าน canvas เพื่อลบ EXIF/GPS/ข้อมูลแฝงทั้งหมด (GIF ไม่วาดใหม่เพราะจะหยุดขยับ)
// - URL GIF: เฉพาะ https://media*.giphy.com/media/… เท่านั้น
// ผู้ไลฟ์ (live_server.py) ตรวจซ้ำด้วยกฎเดียวกันเสมอ — ห้ามเชื่อฝั่งนี้อย่างเดียว

export const MAX_FILE = 5 * 1024 * 1024;
export const MAX_DIMENSION = 8192;          // กันภาพกว้าง/สูงผิดปกติ (pixel flood)
export const MAX_PIXELS = 40_000_000;       // ตรงกับ MAX_PIXELS ของ live_server.py
export const OK_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// ---------------------------------------------------------------- ข้อความ
// อักขระควบคุม (เว้น \t \n), กลับทิศ (RLO ฯลฯ), ล่องหน (ZWSP/BOM/word joiner) — เว้น ZWJ U+200D ที่ Emoji ใช้ต่อกัน
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g;
const TAG_RE = /<\s*\/?\s*[a-z!?][^>]*>/gi;                        // <script …>, </div>, <!-- , <?php
const SCHEME_RE = /\b(?:javascript|vbscript|livescript|data\s*:\s*text\/html)\s*:/gi;
const HANDLER_RE = /\bon[a-z]{3,20}\s*=/gi;                         // onerror= onload= …
const COMBINING_RUN_RE = /([\u0300-\u036F\u0483-\u0489\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]{3})[\u0300-\u036F\u0483-\u0489\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]+/g;

/** ทำความสะอาดข้อความ — คืนสตริงที่ปลอดภัย (อาจว่าง) */
export function cleanText(input, max = 500, { singleLine = false } = {}) {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(CTRL_RE, '');
  // ลบซ้ำจนนิ่ง กันการซ้อนเพื่อเลี่ยงตัวกรอง เช่น <scr<script>ipt>
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(TAG_RE, '').replace(SCHEME_RE, '').replace(HANDLER_RE, '');
    if (s === before) break;
  }
  s = s.replace(COMBINING_RUN_RE, '$1');   // สระ/วรรณยุกต์ซ้อนกันเกิน 3 ตัว (ข้อความสแปมทะลุบรรทัด)
  s = singleLine ? s.replace(/\s+/g, ' ') : s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{4,}/g, '   ');
  return Array.from(s.trim()).slice(0, max).join('').trim();
}

// ---------------------------------------------------------------- JSON จากเครือข่าย
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** JSON.parse ที่ทิ้ง key อันตราย (prototype pollution) — พังคืน null */
export function safeJson(raw, maxLen = 256 * 1024) {
  if (typeof raw !== 'string' || raw.length > maxLen) return null;
  try {
    const v = JSON.parse(raw, (k, val) => (BAD_KEYS.has(k) ? undefined : val));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- URL / key
/** URL ของ GIF จาก Giphy เท่านั้น (https, media*.giphy.com, path /media/…) — ไม่ผ่านคืน null */
export function safeGiphyUrl(url) {
  if (typeof url !== 'string' || url.length > 1000 || /[\s"'<>\\`]/.test(url)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!/^media\d*\.giphy\.com$/.test(u.hostname)) return null;
  if (!/^\/media\/[A-Za-z0-9/_.\-]+$/.test(u.pathname)) return null;
  if (u.search && !/^\?[A-Za-z0-9_.\-=&%]*$/.test(u.search)) return null;
  return u.origin + u.pathname + u.search;   // สร้างใหม่จากชิ้นที่ตรวจแล้ว (ตัด #fragment)
}

/** API key ของ Giphy ที่ผู้ไลฟ์ส่งมา — ตัวอักษร/ตัวเลขเท่านั้น */
export function safeGiphyKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9]{16,64}$/.test(key) ? key : '';
}

export function clampInt(v, lo, hi, fallback = lo) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

// ---------------------------------------------------------------- ไฟล์ภาพ
/** ชนิดภาพจากไบต์จริง (ไม่เชื่อนามสกุล/mime) */
export function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// โค้ดที่ไม่ควรอยู่ในไฟล์ภาพ (ไฟล์ polyglot = เปิดเป็นรูปได้ แต่ข้างในซ่อน HTML/สคริปต์)
const PAYLOAD_RE = /<\s*(?:script|iframe|object|embed|svg|html|body|meta|link|form)\b|<\?php|<!doctype|javascript\s*:|vbscript\s*:|\bon(?:load|error|click|mouseover)\s*=/i;
const SCAN_HEAD = 512 * 1024;
const SCAN_TAIL = 128 * 1024;

/** true ถ้าเจอโค้ดฝังในไฟล์ (สแกนหัว 512KB + ท้าย 128KB) */
export function hasEmbeddedPayload(bytes) {
  const dec = new TextDecoder('latin1');
  const head = dec.decode(bytes.subarray(0, SCAN_HEAD));
  if (PAYLOAD_RE.test(head)) return true;
  if (bytes.length > SCAN_HEAD) {
    const tail = dec.decode(bytes.subarray(Math.max(SCAN_HEAD, bytes.length - SCAN_TAIL)));
    if (PAYLOAD_RE.test(tail)) return true;
  }
  return false;
}

async function decodeSize(blob) {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    const size = { w: bmp.width, h: bmp.height, bmp };
    return size;
  }
  return await new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res({ w: img.naturalWidth, h: img.naturalHeight, bmp: img }); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(res => canvas.toBlob(b => res(b), type, quality));
}

/**
 * ตรวจ + ทำความสะอาดไฟล์ภาพก่อนส่ง
 * คืน { ok: true, blob, mime, w, h } หรือ { ok: false, reason: 'bad_type' | 'too_large' | 'unsafe' }
 */
export async function sanitizeImageFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') return { ok: false, reason: 'bad_type' };
  if (file.size > MAX_FILE) return { ok: false, reason: 'too_large' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImage(bytes);
  if (!mime || !OK_MIME.includes(mime)) return { ok: false, reason: 'bad_type' };
  if (hasEmbeddedPayload(bytes)) return { ok: false, reason: 'unsafe' };

  let size;
  try { size = await decodeSize(new Blob([bytes], { type: mime })); }
  catch { return { ok: false, reason: 'bad_type' }; }
  const { w, h, bmp } = size;
  if (!w || !h || w > MAX_DIMENSION || h > MAX_DIMENSION || w * h > MAX_PIXELS) {
    bmp?.close?.();
    return { ok: false, reason: 'too_large' };
  }

  // GIF: คงไฟล์เดิม (วาดใหม่แล้วภาพจะหยุดขยับ) — ผ่านการตรวจ magic bytes + โค้ดฝัง + ขนาดแล้ว
  if (mime === 'image/gif') {
    bmp?.close?.();
    return { ok: true, blob: new Blob([bytes], { type: mime }), mime, w, h };
  }

  // รูปนิ่ง: วาดเฉพาะพิกเซลลง canvas แล้วเข้ารหัสใหม่ → EXIF/GPS/ข้อความแฝง/ส่วนเกินท้ายไฟล์ หายหมด
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp?.close?.();
  const tries = mime === 'image/png'
    ? [['image/png'], ['image/webp', 0.92], ['image/jpeg', 0.88]]
    : mime === 'image/webp' ? [['image/webp', 0.92], ['image/jpeg', 0.88]] : [['image/jpeg', 0.92], ['image/jpeg', 0.8]];
  for (const [type, q] of tries) {
    const out = await canvasToBlob(canvas, type, q);
    // บางเบราว์เซอร์ไม่รองรับ webp → ได้ png กลับมา; ใช้ชนิดจริงของผลลัพธ์
    if (out && out.size <= MAX_FILE && OK_MIME.includes(out.type)) return { ok: true, blob: out, mime: out.type, w, h };
  }
  return { ok: false, reason: 'too_large' };
}

export const REASON_TEXT = {
  bad_type: 'ไฟล์นี้ไม่ใช่รูปที่รองรับ (PNG, JPG, GIF, WEBP)',
  too_large: 'รูปใหญ่เกินไป (ไม่เกิน 5 MB และ 8192 px)',
  unsafe: 'ไฟล์นี้มีโค้ดแฝงอยู่ — ไม่ปลอดภัย จึงไม่ส่ง',
};
