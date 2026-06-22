# Roomio API (Backend)

REST API + cơ sở dữ liệu cho hệ thống quản lý nhà trọ Roomio. Chạy độc lập, triển khai trên một server riêng. Frontend (`roomio-web`) gọi sang qua HTTP.

## Phạm vi sản phẩm hiện tại

MVP đang theo hướng **landlord-first**: API ưu tiên phục vụ dashboard chủ trọ, nhân viên hỗ trợ vận hành và super admin. Các endpoint/role liên quan khách thuê tự phục vụ vẫn tồn tại trong code để chuẩn bị Phase 2, nhưng không phải trọng tâm phát triển hiện tại.

## Công nghệ

- SvelteKit server routes (`@sveltejs/adapter-node`) — chỉ phục vụ REST endpoint, không có UI
- Drizzle ORM + PostgreSQL (driver `pg`); dev dùng PGlite nhúng (không cần cài Postgres)
- Xác thực bằng session cookie ký HMAC-SHA256 (httpOnly)

## Chạy local

```bash
npm install
npm run db:migrate   # dev: tạo schema trong PGlite (thư mục ./pgdata)
npm run seed         # dữ liệu mẫu
npm run dev          # API tại http://localhost:3000
```

Tài khoản mẫu sau khi seed: `ngochau@gmail.com` / `password` (chủ trọ), `superadmin@ngochau.com` / `admin`.

## Lệnh

| Lệnh | Mô tả |
| --- | --- |
| `npm run dev` | Chạy dev (cổng 3000) |
| `npm run build` | Build production |
| `npm run start` | Chạy bản build (`node build/index.js`) |
| `npm run check` | Kiểm tra type |
| `npm run lint` | Lint |
| `npm run db:generate` | Sinh migration mới từ thay đổi schema |
| `npm run db:migrate` | Áp dụng migration |
| `npm run seed` | Tạo dữ liệu mẫu |
| `npm run cleanup:uploads` | Xóa ảnh đối chiếu (đồng hồ, bill) quá 3 tháng |

## Biến môi trường

Xem `.env.example`. Production bắt buộc: `DATABASE_URL` (Postgres thật), `SESSION_SECRET`, `ORIGIN` (domain HTTPS công khai).

## Triển khai (server riêng, vd Oracle Ampere A1 1 OCPU / 6GB / ARM64)

Postgres nằm cùng máy với API. Vì 1 nhân, chạy **một** Node process (không cluster), pool kết nối nhỏ.

```bash
sudo -u postgres createuser roomio --pwprompt
sudo -u postgres createdb roomio -O roomio

export DATABASE_URL="postgres://roomio:matkhau@localhost:5432/roomio"
export SESSION_SECRET="$(openssl rand -base64 48)"
export ORIGIN="https://roomio.example.com"
npm ci && npm run build
npm run db:migrate            # lần đầu / khi đổi schema
PORT=3000 node build/index.js # giữ sống bằng pm2/systemd
```

Tinh chỉnh Postgres cho box 6GB: `shared_buffers=1GB`, `work_mem=16MB`, `max_connections=50`. Đưa thư mục `uploads/` vào backup cùng `pg_dump`.

## Thanh toán & đối soát (payOS)

Khai báo `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` từ kênh thanh toán payOS. API tạo link thanh toán payOS theo từng hóa đơn để phục vụ luồng thu tiền/đối soát cho chủ trọ; tenant self-service portal để Phase 2. payOS gửi webhook về `https://<domain>/api/payos-webhook` hoặc endpoint tương thích cũ `https://<domain>/api/payment-webhook`.

Webhook được xác thực bằng `signature` HMAC-SHA256 theo `PAYOS_CHECKSUM_KEY`, match hóa đơn bằng `orderCode`/`paymentLinkId`, ghi `PaymentTransaction`, rồi tự cập nhật trạng thái hóa đơn và công nợ phòng.

## Upload ảnh qua Cloudflare R2

API có endpoint `POST /api/uploads/presign` để cấp pre-signed URL cho frontend/TMA upload ảnh trực tiếp lên Cloudflare R2, tránh đẩy file qua server API. Cần khai báo `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`. Bucket R2 cần bật CORS cho origin của app với method `PUT` và header `Content-Type`.

Doc tích hợp nhanh cho Telegram Mini App: `docs/tma-r2-upload.md`.

## Lưu ý

- PGlite chỉ cho dev local; production luôn dùng Postgres thật qua `DATABASE_URL`.
- Trước khi mở cho người dùng thật: nâng băm mật khẩu từ SHA-256 lên bcrypt/argon2.
