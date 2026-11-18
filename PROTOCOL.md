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
- Broker (สำรองกันอัตโนมัติ): `wss://broker.emqx.io:8084/mqtt`, `wss://broker.hivemq.com:8884/mqtt`
  - ผู้ไลฟ์ **เชื่อมต่อทุก broker พร้อมกัน** และตอบกลับทาง broker ที่ได้รับ offer มา
  - ผู้ชมใช้ broker แรกที่เชื่อมได้ ถ้า 8 วินาทียังไม่ได้ `status` ให้ลอง broker ถัดไป

### ข้อความ MQTT

| t | จาก → ถึง | ฟิลด์ | ความหมาย |
|---|---|---|---|
| `status` | S → ทุกคน | `live` (bool), `title`, `w`, `h`, `giphy` (คีย์ Giphy หรือ `""`) | ส่งทุก 3 วินาที; `live=false` = หน้าต่างเกมถูกย่อ/ปิด (พักไลฟ์) |
| `end` | S → ทุกคน | – | จบไลฟ์ (ลูกค้าล็อกเอาท์) — ลิงก์นี้ใช้ไม่ได้อีก |
| `offer` | V → S | `vid`, `sdp`, `q` | SDP offer **แบบรวบ ICE ครบแล้ว** (non-trickle) |
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
| `quality` | `q` = `source` \| `1080` \| `720` \| `480` \| `360` | ความสูงเป้าหมาย (คงอัตราส่วน, ไม่ขยายเกินต้นฉบับ) |
| `chat` | `id`, `text` (≤ 500 ตัวอักษร) | ข้อความ/Emoji |
| `gif` | `id`, `url`, `w`, `h` | GIF จาก Giphy — ผู้ไลฟ์ต้องรับเฉพาะ `https://media*.giphy.com/` |
| `file-start` | `id`, `kind` (`image`\|`gif`\|`sticker`), `mime`, `size`, `name` | เริ่มส่งไฟล์ภาพ (≤ 5 MB, `image/png\|jpeg\|gif\|webp`) |
| `file-chunk` | `id`, `seq`, `data` (base64 ของข้อมูลดิบ ≤ 12 KB) | |
| `file-end` | `id` | ผู้ไลฟ์ตรวจขนาด + ชนิดไฟล์จริงก่อนแสดง |

### ผู้ไลฟ์ → ผู้ชม

| t | ฟิลด์ | หมายเหตุ |
|---|---|---|
| `info` | `w`, `h`, `q` | ขนาดวิดีโอที่ส่งจริงตอนนี้ |
| `ack` | `id` | ได้รับและแสดงบนจอผู้ไลฟ์แล้ว (`id` ของ `chat` / `gif` / ไฟล์) |
| `rate` | `wait` (ms) | ส่งถี่เกินไป ให้รอ |
| `error` | `reason` | เช่น `too_large`, `bad_type` |

ข้อจำกัดฝั่งผู้ชม: ส่งได้ไม่เกิน 1 ข้อความ / 0.7 วินาที; ผู้ไลฟ์ต้องจำกัดซ้ำด้วยเสมอ (ห้ามเชื่อฝั่งผู้ชม)
