# Roomio API (Backend)

REST API + cơ sở dữ liệu cho hệ thống quản lý nhà trọ Roomio. Chạy độc lập, triển khai trên một server riêng. Frontend (`roomio-web`) gọi sang qua HTTP.

## Phạm vi sản phẩm hiện tại

MVP đang theo hướng **landlord-first**: API ưu tiên phục vụ dashboard chủ trọ, nhân viên hỗ trợ vận hành và super admin. Các endpoint/role liên quan khách thuê tự phục vụ vẫn tồn tại trong code để chuẩn bị Phase 2, nhưng không phải trọng tâm phát triển hiện tại.

## Hai trục phân loại

Roomio dùng hai trục độc lập ở cấp **Property** (cụm quản lý — không phải tòa nhà vật lý). Một tài khoản chủ trọ có thể sở hữu nhiều property; mỗi property mang một cặp giá trị riêng.

### Trục A — `rentalType` (ảnh hưởng giá và hạn mức)

| Mã DB        | Nhãn tiếng Việt                             | Nhóm giá   |
| ------------ | ------------------------------------------- | ---------- |
| `APARTMENT`  | Share phòng chung cư / Co-living            | Co-living  |
| `MOTEL`      | Phòng trọ truyền thống / Căn hộ dịch vụ     | Tiêu chuẩn |
| `DORM`       | KTX / Sleepbox                              | Tiêu chuẩn |
| `WHOLE_UNIT` | Căn hộ chung cư nguyên căn / Nhà nguyên căn | Tiêu chuẩn |

- **Allowlist loại hình:** `LandlordProfile.enabledRentalTypes` — Super Admin cấp danh sách loại hình chủ trọ được phép tạo (comma-separated).
- **Hạn mức thương lượng:** `subscribedStandardRoomLimit` và `subscribedColivingRoomLimit` — số phòng tối đa theo từng nhóm giá đã thương lượng khi cấp/duyệt gói.
- Pricing engine đếm phòng live theo `Property.rentalType`, gom về hai nhóm rồi chọn giá gộp hoặc tách (rẻ hơn). Chi tiết: [`docs/subscription-pricing.md`](docs/subscription-pricing.md).

### Trục B — `operatingModel` (metadata, không ảnh hưởng giá)

| Mã DB          | Nhãn tiếng Việt           |
| -------------- | ------------------------- |
| `UNSPECIFIED`  | Chưa phân loại (mặc định) |
| `OWNED`        | Tự sở hữu                 |
| `RENT_TO_RENT` | Thuê lại để cho thuê      |
| `MANAGED`      | Quản lý hộ chủ nhà        |

Trục B chỉ phục vụ phân loại nội bộ và add-on tương lai — **không** thay đổi bảng giá subscription ở phase hiện tại.

Cùng địa chỉ vật lý có thể có nhiều property (khác `rentalType`) thay vì thêm entity zone. Checklist regression sau migrate: [`docs/rental-type-regression-checklist.md`](docs/rental-type-regression-checklist.md).

## Công nghệ

- SvelteKit server routes (`@sveltejs/adapter-node`) — chỉ phục vụ REST endpoint, không có UI
- Drizzle ORM + PostgreSQL (driver `pg`)
- Xác thực bằng session cookie ký HMAC-SHA256 (httpOnly)

## Chạy local

```bash
npm install
npm run dev          # tự migrate schema rồi chạy API tại http://localhost:3000
```

Local dùng Postgres thật giống production. Tạo database local rồi đặt `DATABASE_URL` trong `.env`, ví dụ:

```bash
createdb roomio
cp .env.example .env
# sửa DATABASE_URL + SUPER_ADMIN_ACCOUNTS trong .env
```

## Lệnh

| Lệnh                      | Mô tả                                         |
| ------------------------- | --------------------------------------------- |
| `npm run dev`             | Tự migrate rồi chạy dev (cổng 3000)           |
| `npm run build`           | Build production                              |
| `npm run start`           | Tự migrate rồi chạy bản build                 |
| `npm run check`           | Kiểm tra type                                 |
| `npm run lint`            | Lint                                          |
| `npm run db:generate`     | Sinh migration mới từ thay đổi schema         |
| `npm run db:migrate`      | Áp dụng migration thủ công khi cần            |
| `npm run cleanup:uploads` | Xóa ảnh đối chiếu (đồng hồ, bill) quá 3 tháng |

Lịch sử automation được tự dọn khi chạy tác vụ: log job giữ 90 ngày; thông báo đã gửi, thất bại hoặc đã bỏ qua giữ 180 ngày. Thông báo đang chờ gửi không bị xóa.

## Biến môi trường

Xem `.env.example`. Production bắt buộc có `DATABASE_URL`, `SESSION_SECRET`, `ORIGIN`, `PUBLIC_APP_ORIGIN` và `SUPER_ADMIN_ACCOUNTS`. Khi bật Telegram Mini App, bắt buộc thêm `BOT_TOKEN`, `BOT_USERNAME`, `MINIAPP_SHORT_NAME`, `TELEGRAM_WEBHOOK_SECRET`. Super Admin lấy trực tiếp từ env, không lưu trong bảng `User` và không cần seed. Có thể khai báo nhiều thông tin đăng nhập, phân cách bằng dấu phẩy; tất cả cùng đại diện cho một Super Admin và dùng chung quyền quản trị. Mật khẩu Super Admin phải dài ít nhất 16 ký tự và không được dùng chuỗi mẫu trong tài liệu.

## Đồng bộ production về local

Khi cần debug bằng dữ liệu thật, dump DB trên server rồi restore vào Postgres local:

```bash
# Server
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file=roomio.dump

# Máy local
dropdb --if-exists roomio_local
createdb roomio_local
pg_restore --clean --if-exists --no-owner --no-acl --dbname=roomio_local roomio.dump
```

Sau đó trỏ `.env` local về `postgres://.../roomio_local`. Super Admin vẫn dùng `SUPER_ADMIN_ACCOUNTS` trong env nên không phụ thuộc dữ liệu dump.

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

Nếu chạy bằng Docker Compose, đặt file `.env` trên server cạnh `docker-compose.yml`. File này không commit lên git:

```bash
POSTGRES_PASSWORD=mat-khau-db-rat-dai
SUPER_ADMIN_ACCOUNTS=owner@domain.com:<mat-khau-random-tren-16-ky-tu>:Super Admin
SESSION_SECRET=<ket-qua-openssl-rand-base64-48>
CRON_SECRET=<ket-qua-openssl-rand-base64-48-khac>
ORIGIN=https://api.roomio.example.com
PUBLIC_APP_ORIGIN=https://roomio.example.com
TELEGRAM_WEBHOOK_SECRET=<chuoi-random-rieng>
PAYOS_ENC_KEY=<base64-32-byte-neu-dung-payos-rieng>
```

Sau đó chạy:

```bash
docker compose up -d --build
```

`npm run start` trong container sẽ tự chạy migration trước khi boot API. Không cần seed.

Tinh chỉnh Postgres cho box 6GB: `shared_buffers=1GB`, `work_mem=16MB`, `max_connections=50`. Đưa thư mục `uploads/` vào backup cùng `pg_dump`.

## Thanh toán & đối soát (payOS)

Roomio hiện tách 2 luồng payOS:

- **Tiền thuê khách → chủ trọ**: mỗi chủ trọ kết nối payOS riêng trong app/Super Admin. API mã hóa `apiKey` và `checksumKey` bằng `PAYOS_ENC_KEY` trước khi lưu DB. Khi tạo link thanh toán hóa đơn, API dùng key riêng của chủ trọ sở hữu hóa đơn; nếu chủ trọ chưa kết nối payOS thì trả về VietQR để đối soát thủ công.
- **Phí subscription chủ trọ → nền tảng Roomio**: dùng `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` từ env. Luồng này đi webhook riêng `/api/payos-webhook/subscription` và hiện mới ack/verify, chưa tự gia hạn gói.

Webhook tiền thuê đi về `https://<domain>/api/payos-webhook` hoặc endpoint tương thích cũ `https://<domain>/api/payment-webhook`. API match hóa đơn bằng `orderCode`/`paymentLinkId`, suy ra chủ trọ, rồi verify `signature` HMAC-SHA256 bằng checksum key riêng của chủ trọ đó. Chỉ sau khi verify hợp lệ mới ghi `PaymentTransaction`, cập nhật trạng thái hóa đơn và công nợ phòng.

Production cần khai báo `PAYOS_ENC_KEY` để mã hóa key riêng từng chủ trọ:

```bash
PAYOS_ENC_KEY="$(openssl rand -base64 32)"
```

## Upload ảnh qua Cloudflare R2

API có endpoint `POST /api/uploads/presign` để cấp pre-signed URL cho frontend/TMA upload ảnh trực tiếp lên Cloudflare R2, tránh đẩy file qua server API. Cần khai báo `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`. Bucket R2 cần bật CORS cho origin của app với method `PUT` và header `Content-Type`.

Doc tích hợp nhanh cho Telegram Mini App: `docs/tma-r2-upload.md`.

## Lưu ý

- Không còn PGlite. Nếu thiếu `DATABASE_URL`, API và migrate sẽ fail sớm để tránh chạy nhầm DB.
- Trước khi mở cho người dùng thật: đảm bảo `SESSION_SECRET`, `PAYOS_ENC_KEY`, `SUPER_ADMIN_ACCOUNTS` đã đổi sang giá trị mạnh.
