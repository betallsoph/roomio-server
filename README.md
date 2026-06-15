# Roomio API (Backend)

REST API + cơ sở dữ liệu cho hệ thống quản lý nhà trọ Roomio. Chạy độc lập, triển khai trên một server riêng. Frontend (`roomio-web`) gọi sang qua HTTP.

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

## Đối soát thanh toán (SePay)

Khai báo webhook trỏ về `https://<domain>/api/payment-webhook`, đặt `SEPAY_API_KEY` khớp header `Authorization: Apikey <key>`. Tiền vào tài khoản có mã hóa đơn trong nội dung CK sẽ tự xác nhận thanh toán.

## Lưu ý

- PGlite chỉ cho dev local; production luôn dùng Postgres thật qua `DATABASE_URL`.
- Trước khi mở cho người dùng thật: nâng băm mật khẩu từ SHA-256 lên bcrypt/argon2.
