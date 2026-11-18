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
| `chat` | `id`, `text` (≤ 500 ตัวอักษร), `all?` | ข้อความ/Emoji · `all: true` = "Overall" จากผู้ชมที่ดูหลายเกม (ส่งช่องเดียว ป๊อปอัปไม่ใส่ชื่อลูกค้า) — ใช้กับ `gif`/`file-start` ได้เหมือนกัน |
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

เปิด `watch.html` **ไม่มี `#token`** → ผู้ชมเข้าสู่ระบบด้วย Google → รายการ "เกมของฉัน" (เพิ่มเกมด้วย username/password ของเกมนั้นครั้งเดียว) → ดูเกมเดียวหรือหลายเกมพร้อมกัน (สูงสุด 4) — แต่ละช่องใช้ token ของเกมนั้นกับข้อ 1–6 ตามเดิม (ลิงก์ Discord ยังใช้ได้เหมือนเดิม = ดู 1 เกม)

- **กุญแจร้าน**: ECDH P-256 คู่เดียวต่อร้าน · private อยู่ที่ `Data/Live/lobby_key.json` ของโปรแกรม (DPAPI) · public (65 ไบต์ uncompressed → base64url) ฝังใน `js/lobby-config.js` — **ต้องตรงกับหน้าตั้งค่า "กุญแจร้าน"**
- **Topic**: `id = hex(SHA-256(pub)[:16])` · คำขอ `dtlobby/v1/<id>/q` · คำตอบ `dtlobby/v1/<id>/r/<rid>` (ผู้ชม subscribe ก่อนส่ง) · ส่ง/ตอบทุก broker (ข้อ 3) QoS 0 ไม่ retain
- **คำขอ**: `0x01 || ephPub[65] || iv[12] || AES-256-GCM(JSON, aad = topic q)` — ephPub ใหม่ทุกคำขอ
- **คำตอบ**: `iv[12] || AES-256-GCM(JSON, aad = topic r)`
- **กุญแจ**: `shared = ECDH(eph, shop)` (x 32 ไบต์) → `HKDF-SHA256(shared, salt="dailytask-lobby/v1", info="q"||ephPub / "r"||ephPub, 32)`
- ทุกคำขอมี `t`, `rid` (hex 32 ตัว, ใช้ครั้งเดียว), `ts` (ms, ต่างไม่เกิน 60 วิ) · คำตอบมี `t` เดียวกับคำขอ + `ts`

| t | คำขอ | คำตอบ |
|---|------|-------|
| `hello` | — | `{ok, clientId}` Google OAuth Client ID ของร้าน (ว่าง/`ok:false` = ยังไม่เปิดล็อกอิน) |
| `login` | `{gid}` gid = Google ID token | `{ok:true, card, sub, games, dropped}` · `{ok:false, reason: "google"\|"disabled"}` |
| `list` | `{card, sub}` | `{ok:true, games, dropped}` · `{ok:false, reason:"expired"}` |
| `add` | `{card, sub, u, p}` | `{ok:true, added: [id…], games, dropped}` — ไอดี/รหัสตรงหลายรายการ (เกมต่างกัน) = เพิ่มทุกรายการ · `{ok:false, reason}` |
| `remove` | `{card, sub, id}` | `{ok:true, games, dropped}` |
| `logout` | `{card}` | `{ok:true}` |

- **games** = `[{id, name, game, title, live, token, since}]` — `game` = ชื่อเกมจากตั้งค่าสแกน (`stage1.game`, แบบเดียวกับ HUD), `title` = ชื่อหน้าต่างเกม, `token` มีเฉพาะเกมที่กำลังส่งภาพ (`live:true`), `since` = เวลาเข้าไอดี (ms) · เรียง: กำลังไลฟ์ก่อน ตามเวลาเข้าไอดี (เข้าก่อนอยู่บน) → ไม่ได้ไลฟ์ ตามลำดับที่เพิ่ม · `dropped` = จำนวนเกมที่หลุดจากรายการรอบนี้ (ลูกค้าเปลี่ยนรหัส/ถูกลบ) · ทุกครั้งที่ส่งรายการ ผู้ไลฟ์เพิ่มรายการอื่นที่ไอดี/รหัสตรงกับเกมที่เพิ่มไว้ให้เอง (แสดงคู่กัน)
- `reason` ของ add: `bad` (ไอดี/รหัสผิด), `locked` + `wait` วิ (ผิด 5 ครั้งใน 15 นาที ต่อบัญชี Google และต่อ username → พัก 15 นาที), `expired`
- **ฝั่งผู้ไลฟ์ตรวจ Google ID token เอง**: RS256 กับ `https://www.googleapis.com/oauth2/v3/certs`, `iss` = `accounts.google.com`, `aud` = Client ID, ยังไม่หมดอายุ
- **บัตรผู้ชม (`card`)**: สุ่ม 32 ไบต์ base64url (43 ตัว) 1 ใบต่อเบราว์เซอร์ เก็บใน `localStorage["dt_viewer"]` `{card, sub, email}` · ฝั่งผู้ไลฟ์ (`Data/Live/viewer_cards.json` v2) เก็บแค่ SHA-256 ของบัตร + บัญชีตาม Google `sub` ที่มีรายการเกม `{cid, ลายนิ้วมือรหัส}` · ออกจากระบบ = ยกเลิกบัตรของเบราว์เซอร์นั้น (เกมยังผูกกับบัญชี Google — ล็อกอินใหม่ได้รายการเดิม) · `sub` ไม่ตรง = ใช้ไม่ได้ · ลูกค้าเปลี่ยนรหัส/ถูกลบ = เกมนั้นหลุดจากรายการ (เกมอื่นไม่กระทบ) · ไฟล์ v1 (บัตรละ 1 เกม) แปลงอัตโนมัติ
- หน้าเว็บถาม `list` ซ้ำทุก 15 วิ (หน้ารายการ) / 30 วิ (กำลังดู) → ไลฟ์รอบใหม่ได้ token ใหม่ = ช่องนั้นต่อให้เองอัตโนมัติ · ได้ `end` ในโหมดนี้ = รอรอบถัดไป · กลับไปหน้ารายการ = ปิดทุกช่อง (คืนโควตาผู้ชม)
- **ดูหลายเกม**: 1 ช่อง = 1 RTCPeerConnection + Signal ของเกมนั้น (นับเป็นผู้ชม 1 คนของเกมนั้น) · เสียงทุกช่องเล่นพร้อมกัน ปรับ/ปิดแยกช่อง (`localStorage["dt_vol:<id>"]`) · แชตเลือกปลายทาง: เกมใดเกมหนึ่ง หรือ Overall (`all: true` ข้อ 5)
- **CSP ของปุ่ม Google**: `script-src https://accounts.google.com/gsi/client`, `frame-src`/`connect-src https://accounts.google.com/gsi/`, `style-src https://accounts.google.com/gsi/style 'unsafe-inline'` (GSI แทรก `<style>` เอง) · `referrer` = `strict-origin-when-cross-origin` (Google ต้องรู้ origin) · สคริปต์ Google โหลดเฉพาะตอนต้องแสดงหน้าเข้าสู่ระบบ
