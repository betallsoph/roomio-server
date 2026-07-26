# Cron hằng ngày qua Upstash QStash

Endpoint: `POST /api/qstash/cron`

QStash gọi URL công khai của API theo lịch (cron), ký request bằng `Upstash-Signature`. Roomio verify chữ ký rồi chạy cùng logic với `/api/cron/monthly` (quét overdue, nhắc hóa đơn/điện nước/hợp đồng, soạn hóa đơn nháp).

## 1. Biến môi trường trên VPS API

Thêm vào `.env` (lấy từ [Upstash Console](https://console.upstash.com/) → QStash → Signing Keys):

```bash
QSTASH_CURRENT_SIGNING_KEY=sig_...
QSTASH_NEXT_SIGNING_KEY=sig_...
```

Giữ `CRON_SECRET` nếu vẫn dùng GitHub Actions cron song song (fallback).

## 2. URL công khai

QStash phải gọi được từ internet. Với setup hiện tại:

```text
https://roomio.roomieverse.me/api/qstash/cron
```

(Nginx web proxy `/api/` sang API qua Tailscale — giống payOS webhook.)

## 3. Tạo schedule trên Upstash Console

1. Vào **QStash** → **Schedules** → **Create schedule**
2. **Destination URL:** `https://roomio.roomieverse.me/api/qstash/cron`
3. **Method:** `POST`
4. **Cron:** `0 1 * * *` (01:00 UTC = 08:00 giờ VN)
5. **Body (optional):** `{}` hoặc `{"draft":true}` — mặc định vẫn soạn nháp
6. **Retries:** bật (QStash tự retry nếu API timeout/5xx)

Hoặc dùng CLI:

```bash
curl -X POST "https://qstash.upstash.io/v2/schedules/https://roomio.roomieverse.me/api/qstash/cron" \
  -H "Authorization: Bearer <QSTASH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Upstash-Cron: 0 1 * * *" \
  -d '{}'
```

(`QSTASH_TOKEN` lấy từ Console → QStash → Token — chỉ dùng khi tạo schedule, không cần đặt trên VPS.)

## 4. Test tay

Trong Upstash Console → **Publish** → gửi 1 message tới URL trên, body `{}`. Response 200 + JSON `success: true`.

Hoặc sau deploy, xem log container `roomio-app`:

```bash
docker logs roomio-app --tail 50
```

## 5. Tắt GitHub Actions cron (khi QStash ổn)

Repo `roomio-server` có `.github/workflows/cron.yml` (SSH + curl nội bộ). Khi QStash chạy ổn vài ngày, có thể:

- Disable workflow trên GitHub (**Actions → Cron Monthly → … → Disable**), hoặc
- Xóa / comment schedule trong `cron.yml`

Không bắt buộc tắt ngay — hai cách có thể chạy song song (logic idempotent trong ngày).

## Body tùy chọn

| Field | Mô tả |
| --- | --- |
| `month` | `YYYY-MM`, mặc định tháng hiện tại |
| `draft` | `false` để chỉ nhắc, không soạn hóa đơn nháp |

Ví dụ: `{"month":"2026-07","draft":false}`
