# Cách tính phí Roomio

Phí SaaS được tính theo tổng số phòng đang được quản lý trong tài khoản chủ trọ. Phòng trống vẫn là một đơn vị tính phí vì hệ thống vẫn lưu và vận hành dữ liệu phòng đó.

## Trọ / CHDV / Sleepbox

| Số phòng | Phí mỗi tháng |
| -------- | ------------: |
| 0–3      |      Miễn phí |
| 4–10     |      149.000đ |
| 11–25    |      349.000đ |
| 26–50    |      699.000đ |
| 51–100   |    1.399.000đ |
| Trên 100 |       Liên hệ |

## Co-living / share căn

Co-living vẫn tính theo **số phòng**, không tính theo giường.

| Số phòng | Phí mỗi tháng |
| -------- | ------------: |
| 0–3      |      Miễn phí |
| 4–10     |      129.000đ |
| 11–25    |      319.000đ |
| 26–50    |      629.000đ |
| 51–100   |    1.199.000đ |
| Trên 100 |       Liên hệ |

## Quy ước hệ thống

- Gói được lưu theo sức chứa: `FREE`, `ROOMS_4_10`, `ROOMS_11_25`, `ROOMS_26_50`, `ROOMS_51_100`, `ROOMS_101_PLUS`.
- Không còn khái niệm Premium hay Enterprise.
- Các loại hình chung cư, phòng trọ, CHDV và KTX/Sleepbox cùng kích hoạt bảng giá chuẩn một lần.
- Loại hình `COLIVING` kích hoạt bảng giá co-living.
- Nếu tài khoản bật cả loại hình chuẩn và co-living, hệ thống tính mỗi bảng một lần rồi cộng lại. Việc bật nhiều loại hình cùng thuộc nhóm chuẩn không nhân phí nhiều lần.
- `MONTHLY` có hạn một tháng. `YEARLY` có hạn một năm và giá hiện bằng đúng 12 tháng, chưa áp dụng chiết khấu.
- Phòng trống vẫn được tính vào số phòng đang quản lý. Nếu số phòng thực tế vượt sức chứa gói, admin sẽ thấy cảnh báo.
- Gói trên 100 phòng chưa có giá tự động và hiển thị `Liên hệ`.

Code nguồn của bảng giá nằm tại `src/lib/server/subscription-pricing.ts`. Endpoint `GET /api/subscription/quote` trả về báo giá hiện tại của chủ trọ đang đăng nhập.
