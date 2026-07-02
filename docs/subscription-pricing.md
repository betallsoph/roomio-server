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
- Giá yêu cầu dựa trên cơ cấu số phòng dự kiến do chủ trọ khai báo trước khi tạo phòng.
- Với danh mục kết hợp chuẩn + co-living, hệ thống tính cả hai phương án rồi tự lấy giá thấp hơn:
  - `Gộp`: gom toàn bộ phòng, dùng bảng chuẩn nếu có ít nhất một phòng chuẩn.
  - `Tách`: tính riêng số phòng chuẩn và số phòng co-living theo từng bảng rồi cộng lại.
- Chỉ xét phương án tách khi mỗi nhóm có ít nhất 4 phòng. Mức Free chỉ áp dụng một lần cho toàn tài khoản, không thể tách 3 + 3 phòng để hưởng hai lần Free.
- Ví dụ 4 phòng chuẩn + 4 phòng co-living: giá gộp 149.000đ, giá tách 278.000đ nên lấy giá gộp.
- Ví dụ 8 phòng chuẩn + 8 phòng co-living: giá gộp 349.000đ, giá tách 278.000đ nên lấy giá tách.
- `MONTHLY` có hạn một tháng. `YEARLY` có hạn một năm và giá hiện bằng đúng 12 tháng, chưa áp dụng chiết khấu.
- Phòng trống vẫn được tính vào số phòng đang quản lý.
- Khi Super Admin duyệt, hệ thống lưu riêng hạn mức phòng chuẩn và co-living. API tạo phòng chặn cả tổng sức chứa của gói lẫn hạn mức từng nhóm; gói trả phí hết hạn cũng không được tạo thêm phòng.
- Gói trên 100 phòng chưa có giá tự động và hiển thị `Liên hệ`.

Code nguồn của bảng giá nằm tại `src/lib/server/subscription-pricing.ts`. Endpoint `GET /api/subscription/quote` trả về báo giá hiện tại của chủ trọ đang đăng nhập.

## Yêu cầu điều chỉnh gói

- Chủ trọ xem báo giá tại tab `Cài đặt → Gói Roomio`.
- `POST /api/subscription/requests` tạo một yêu cầu với gói, thời hạn và các loại hình muốn bật thêm. Mỗi tài khoản chỉ có một yêu cầu `pending` tại một thời điểm.
- Chủ trọ có thể hủy yêu cầu đang chờ bằng `PUT` với action `cancel`.
- Super Admin duyệt hoặc từ chối bằng `PUT` với action `approve` hoặc `reject`.
- Khi duyệt, hệ thống mới cập nhật gói và ngày hết hạn, đồng thời nối các loại hình được yêu cầu vào danh sách đang quản lý. Yêu cầu chỉ thêm loại hình không làm gia hạn lại gói hiện tại.
- Chủ trọ khai báo số phòng chuẩn và co-living dự kiến; hệ thống tự chọn gói khớp với tổng số phòng và tính giá trước khi phòng được tạo.
- Việc chỉ bật thêm loại hình với hạn mức bằng 0 không tự cộng phí, nhưng chủ trọ vẫn chưa thể tạo phòng thuộc nhóm đó.
- Nếu số phòng thực tế vượt mức đã khai báo trong lúc yêu cầu đang chờ, yêu cầu cũ không được duyệt và chủ trọ phải gửi lại để tính giá mới.
