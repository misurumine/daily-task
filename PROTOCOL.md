# Daily Task Live — Protocol v1

ข้อตกลงการสื่อสารระหว่าง **ผู้ไลฟ์** (DailyTaskApp, Python/aiortc) กับ **ผู้ชม** (`public/watch.html`)
ทั้งสองฝั่งต้องทำตามเอกสารนี้ตรงกันทุกจุด — แก้ฝั่งหนึ่งต้องแก้อีกฝั่งด้วยเสมอ

## 1. ลิงก์และ Token

```
https://misurumine.github.io/daily-task/watch.html#<token>
```

- `token` = 16 ไบต์สุ่ม (128-bit) เข้ารหัส **base64url ไม่มี `=`** (22 ตัวอักษร)
- อยู่หลัง `#` → เบราว์เซอร์ไม่ส่งไปที่ GitHub, ไม่ติด log ของ server
- สร้างใหม่ทุกครั้งที่ลูกค้าล็อกอิน, ยกเลิกเมื่อล็อกเอาท์

## 2. กุญแจและ Topic (HKDF-SHA256)

```
ikm  = base64url_decode(token)            # 16 bytes
salt = UTF-8("dailytask-live/v1")
topicId = HKDF(ikm, salt, info=UTF-8("topic"), len=16)   → hex (32 ตัวอักษร)
key     = HKDF(ikm, salt, info=UTF-8("key"),   len=32)   → AES-256-GCM
base    = "dtlive/v1/" + hex(topicId)
```

| Topic | ทิศทาง |
|---|---|
| `<base>/s` | ผู้ไลฟ์ → ผู้ชมทุกคน (และข้อความระบุ `to`) |
| `<base>/v` | ผู้ชม → ผู้ไลฟ์ |

Topic ไม่เปิดเผย token (เป็น hash) — คนที่ไม่มีลิงก์ทั้งหาช่องไม่เจอและอ่านข้อความไม่ออก

## 3. ซองข้อความ MQTT (เข้ารหัสทุกข้อความ)

```
payload (binary) = iv[12] || AES-256-GCM(key, iv, plaintext, aad=UTF-8(topic))  # รวม tag 16 ไบต์ท้าย
plaintext        = UTF-8(JSON) และต้องมี "ts" (Unix ms)
```

- ผู้รับต้องทิ้งข้อความที่ถอดรหัสไม่ได้ หรือ `|now - ts| > 60 วินาที`
- QoS 0, `retain = false` เสมอ (ไม่มีข้อมูลค้างบน broker)
- Broker (สำรองกันอัตโนมัติ — broker ฟรีล่ม/ช้าเป็นช่วง ๆ):
  1. `wss://broker.emqx.io:8084/mqtt`
  2. `wss://mqtt-dashboard.com:8884/mqtt` (HiveMQ — เซิร์ฟเวอร์เดียวกับ `broker.hivemq.com` แต่ไม่มี IPv6 จึงต่อได้เร็วกว่า)
  3. `wss://test.mosquitto.org:8081/mqtt`
  - **ทั้งสองฝั่งเชื่อมต่อทุก broker พร้อมกัน**
  - ผู้ไลฟ์ส่ง `status`/`end` ออกทุก broker และตอบ `answer`/`reject` ทาง broker ที่ได้รับ offer มา
  - ผู้ชมรับข้อความจากทุก broker และส่ง `offer`/`bye` ออกทุก broker ที่ต่ออยู่

### ข้อความ MQTT

| t | จาก → ถึง | ฟิลด์ | ความหมาย |
|---|---|---|---|
| `status` | S → ทุกคน | `live` (bool), `title`, `w`, `h`, `giphy` (คีย์ Giphy หรือ `""`) | ส่งทุก 3 วินาที; `live=false` = หน้าต่างเกมถูกย่อ/ปิด (พักไลฟ์) |
| `end` | S → ทุกคน | – | จบไลฟ์ (ลูกค้าล็อกเอาท์) — ลิงก์นี้ใช้ไม่ได้อีก |
| `offer` | V → S | `vid`, `sdp`, `q`, `fps` | SDP offer **แบบรวบ ICE ครบแล้ว** (non-trickle) |
| `answer` | S → V | `to`, `sdp` | SDP answer (non-trickle) |
| `reject` | S → V | `to`, `reason` | ปฏิเสธ (`full` = ผู้ชมเต็ม, `ended` = จบไลฟ์แล้ว) |
| `bye` | V → S | `vid` | ผู้ชมออก |

`vid` = id สุ่มของผู้ชม (16 hex) สร้างใหม่ทุกครั้งที่เปิดหน้า

**กันข้อความซ้ำ (บังคับ):** QoS 0 + หลาย broker ทำให้ข้อความเดียวกันอาจมาถึงซ้ำได้
- ผู้ไลฟ์ต้องข้าม `offer` ที่ `(vid, sdp)` ซ้ำกับที่ตอบไปแล้ว (ถ้าตอบซ้ำ ผู้ชมจะได้ answer 2 อันและหลุด)
- ผู้ชมรับ `answer` เฉพาะตอน `signalingState === "have-local-offer"` เท่านั้น

## 4. WebRTC

- ผู้ชมเป็นฝ่าย **offer**: transceiver `video` + `audio` แบบ `recvonly` และ DataChannel ชื่อ `ctl` (ordered, reliable)
- ICE: STUN `stun:stun.l.google.com:19302`, `stun1…`, `stun2…` (ไม่มี TURN)
- วิดีโอ: ขนาดเท่าหน้าต่างเกม (`source`) หรือย่อตามที่ผู้ชมเลือก; เสียง: เสียงของโปรเซสเกมเท่านั้น

## 5. DataChannel `ctl` (JSON text)

### ผู้ชม → ผู้ไลฟ์

| t | ฟิลด์ | หมายเหตุ |
|---|---|---|
| `quality` | `q` = `source` \| `1080` \| `720` \| `480` \| `360`, `fps` (ตัวเลข) — ส่งอย่างใดอย่างหนึ่งหรือทั้งคู่ | ความสูงเป้าหมาย (คงอัตราส่วน, ไม่ขยายเกินต้นฉบับ) / เฟรมต่อวินาที (ผู้ไลฟ์ปัดลงไม่ให้เกิน Hz จอตัวเอง) |
| `chat` | `id`, `text` (≤ 500 ตัวอักษร) | ข้อความ/Emoji |
| `gif` | `id`, `url`, `w`, `h` | GIF จาก Giphy — ผู้ไลฟ์ต้องรับเฉพาะ `https://media*.giphy.com/` |
| `file-start` | `id`, `kind` (`image`\|`gif`\|`sticker`), `mime`, `size`, `name` | เริ่มส่งไฟล์ภาพ (≤ 5 MB, `image/png\|jpeg\|gif\|webp`) |
| `file-chunk` | `id`, `seq`, `data` (base64 ของข้อมูลดิบ ≤ 12 KB) | |
| `file-end` | `id` | ผู้ไลฟ์ตรวจขนาด + ชนิดไฟล์จริงก่อนแสดง |

### ผู้ไลฟ์ → ผู้ชม

| t | ฟิลด์ | หมายเหตุ |
|---|---|---|
| `info` | `w`, `h`, `q`, `fps`, `maxFps`, `fpsOptions` | ขนาด/fps ที่ส่งจริงตอนนี้ · `maxFps` = Hz จอของผู้ไลฟ์ · `fpsOptions` = ตัวเลือกที่ผู้ชมเลือกได้ (ไม่มี = ผู้ไลฟ์รุ่นเก่า ล็อก 30 fps) |
| `ack` | `id` | ได้รับและแสดงบนจอผู้ไลฟ์แล้ว (`id` ของ `chat` / `gif` / ไฟล์) |
| `rate` | `wait` (ms) | ส่งถี่เกินไป ให้รอ |
| `error` | `reason` | `too_large`, `bad_type`, `unsafe` (ไฟล์ภาพมีโค้ดฝัง — polyglot) |

ข้อจำกัดฝั่งผู้ชม: ส่งได้ไม่เกิน 1 ข้อความ / 0.7 วินาที; ผู้ไลฟ์ต้องจำกัดซ้ำด้วยเสมอ (ห้ามเชื่อฝั่งผู้ชม)

## 6. กรองข้อมูล (ทั้งสองฝั่งใช้กฎเดียวกัน — ฝั่งผู้ไลฟ์ต้องตรวจซ้ำเสมอ)

- **ข้อความ** (`chat`, ชื่อไฟล์, ชื่อเกมใน `status`): ลบอักขระควบคุม (เว้น `\n` `\t`), อักขระกลับทิศ U+202A–202E / U+2066–2069, อักขระล่องหน (ZWSP, BOM ฯลฯ — เว้น ZWJ ของ Emoji), แท็ก HTML `<…>`, `javascript:`/`vbscript:`/`data:text/html`, `onxxx=`, สระ/วรรณยุกต์ซ้อนเกิน 3 ตัว · ข้อความที่เหลือว่าง = ไม่ส่ง
- **รูป/สติกเกอร์/GIF**: ไบต์หัวไฟล์ต้องตรงชนิด (PNG/JPEG/GIF/WEBP), ห้ามมีโค้ดฝัง (`<script`, `<svg`, `<?php`, `javascript:` ฯลฯ ในหัว 512KB/ท้าย 128KB → `unsafe`), กว้าง/สูง ≤ 8192 px และ ≤ 40 ล้านพิกเซล · รูปนิ่งถูกวาดใหม่ (ลบ EXIF/GPS/ข้อมูลแฝง) ทั้งก่อนส่งและตอนผู้ไลฟ์รับ · GIF คงไฟล์เดิม (ภาพเคลื่อนไหว)
- **GIF จาก Giphy**: URL ต้องเป็น `https://media*.giphy.com/media/…` (ไม่มี user/port/อักขระพิเศษ) · API key ใน `status.giphy` ต้องเป็นตัวอักษร/ตัวเลข 16–64 ตัว
- หน้าเว็บมี Content-Security-Policy จำกัดแหล่งสคริปต์/รูป/การเชื่อมต่อ และไลบรารี MQTT จาก CDN มี `integrity` (SRI)

## 7. เข้าสู่ระบบแทนลิงก์ (lobby) — `js/lobby.js` ↔ `live_lobby.py`

เปิด `watch.html` **ไม่มี `#token`** → ผู้ชมเข้าสู่ระบบด้วย Google แล้วกรอก username/password ของเกม (ข้อมูลลูกค้าในโปรแกรมผู้ไลฟ์) → ได้ token ไลฟ์ของลูกค้าคนนั้น แล้วใช้ข้อ 1–6 ตามเดิม (ลิงก์ Discord ยังใช้ได้เหมือนเดิม)

- **กุญแจร้าน**: ECDH P-256 คู่เดียวต่อร้าน · private อยู่ที่ `Data/Live/lobby_key.json` ของโปรแกรม (DPAPI) · public (65 ไบต์ uncompressed → base64url) ฝังใน `js/lobby-config.js` — **ต้องตรงกับหน้าตั้งค่า "กุญแจร้าน"**
- **Topic**: `id = hex(SHA-256(pub)[:16])` · คำขอ `dtlobby/v1/<id>/q` · คำตอบ `dtlobby/v1/<id>/r/<rid>` (ผู้ชม subscribe ก่อนส่ง) · ส่ง/ตอบทุก broker (ข้อ 3) QoS 0 ไม่ retain
- **คำขอ**: `0x01 || ephPub[65] || iv[12] || AES-256-GCM(JSON, aad = topic q)` — ephPub ใหม่ทุกคำขอ
- **คำตอบ**: `iv[12] || AES-256-GCM(JSON, aad = topic r)`
- **กุญแจ**: `shared = ECDH(eph, shop)` (x 32 ไบต์) → `HKDF-SHA256(shared, salt="dailytask-lobby/v1", info="q"||ephPub / "r"||ephPub, 32)`
- ทุกคำขอมี `t`, `rid` (hex 32 ตัว, ใช้ครั้งเดียว), `ts` (ms, ต่างไม่เกิน 60 วิ) · คำตอบมี `t` เดียวกับคำขอ + `ts`

| t | คำขอ | คำตอบ |
|---|------|-------|
| `hello` | — | `{ok, clientId}` Google OAuth Client ID ของร้าน (ว่าง/`ok:false` = ยังไม่เปิดล็อกอิน) |
| `login` | `{gid, u, p, pick?}` gid = Google ID token | สำเร็จ `{ok:true, card, name, token, live}` · ไม่สำเร็จ `{ok:false, reason}` |
| `resume` | `{card, sub}` | `{ok:true, name, token, live}` (`token` ว่างเมื่อยังไม่ไลฟ์) · `{ok:false, reason:"expired"}` |
| `logout` | `{card}` | `{ok:true}` |

- `reason` ของ login: `bad` (ไอดี/รหัสผิด), `locked` + `wait` วิ (ผิด 5 ครั้งใน 15 นาที ต่อบัญชี Google และต่อ username → พัก 15 นาที), `offline` (ลูกค้ายังไม่ล็อกอิน/ไม่มีไลฟ์), `google` (ID token ไม่ผ่าน), `disabled`, `choose` + `options[{id,name}]` (รหัสนี้ตรงกับหลายรายการที่ไลฟ์อยู่ → ส่ง `pick` ซ้ำ)
- **ฝั่งผู้ไลฟ์ตรวจ Google ID token เอง**: RS256 กับ `https://www.googleapis.com/oauth2/v3/certs`, `iss` = `accounts.google.com`, `aud` = Client ID, ยังไม่หมดอายุ
- **บัตรผู้ชม (`card`)**: สุ่ม 32 ไบต์ base64url (43 ตัว) เก็บใน `localStorage["dt_viewer"]` ของผู้ชม `{card, sub, email, name}` · ฝั่งผู้ไลฟ์เก็บแค่ SHA-256 ใน `Data/Live/viewer_cards.json` ผูกกับลูกค้า + `sub` ของ Google + ลายนิ้วมือรหัส · ใช้ไม่ได้เมื่อ: กดออกจากระบบ, `sub` ไม่ตรง (เปลี่ยนบัญชี Google), ลูกค้าเปลี่ยนรหัส/ถูกลบ · ไม่มีวันหมดอายุนอกจากนี้
- หน้าเว็บถาม `resume` ซ้ำทุก 15 วิ (รอไลฟ์) / 60 วิ (กำลังดู) → ลูกค้าล็อกอินรอบใหม่ได้ token ใหม่ = ต่อให้เองอัตโนมัติ · ได้ `end` ในโหมดนี้ = รอรอบถัดไป (ไม่ใช่ "ลิงก์ใช้ไม่ได้")
- **CSP ของปุ่ม Google**: `script-src https://accounts.google.com/gsi/client`, `frame-src`/`connect-src https://accounts.google.com/gsi/`, `style-src https://accounts.google.com/gsi/style 'unsafe-inline'` (GSI แทรก `<style>` เอง) · `referrer` = `strict-origin-when-cross-origin` (Google ต้องรู้ origin) · สคริปต์ Google โหลดเฉพาะตอนต้องแสดงหน้าเข้าสู่ระบบ
