# สติกเกอร์ชุดของร้าน

1. วางไฟล์รูป (PNG / JPG / GIF / WEBP, ไม่เกิน 5 MB, ชื่อไฟล์ใช้ได้เฉพาะ a-z 0-9 _ - .) ไว้ในโฟลเดอร์นี้
2. เพิ่มชื่อไฟล์ลงใน `index.json` เช่น

```json
[
  { "file": "hello.png", "name": "สวัสดี" },
  { "file": "thanks.gif", "name": "ขอบคุณ" }
]
```

3. commit + push — GitHub Actions จะ deploy ให้เอง
