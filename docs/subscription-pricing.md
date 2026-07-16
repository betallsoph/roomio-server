# Cách tính phí Roomio

Phí SaaS được tính theo tổng số đơn vị cho thuê đang được quản lý trong tài khoản chủ trọ. Phòng/căn trống vẫn là một đơn vị tính phí vì hệ thống vẫn lưu và vận hành dữ liệu đó.

## Loại hình cho thuê (rental type)

| Giá trị DB | Nhãn tiếng Việt | Ghi chú |
| ---------- | --------------- | ------- |
| `APARTMENT` | Share phòng chung cư / Co-living | Alias cũ `COLIVING` tự quy về `APARTMENT` |
| `MOTEL` | Phòng trọ truyền thống / Căn hộ dịch vụ | Alias cũ `SERVICED_APARTMENT` tự quy về `MOTEL` |
| `DORM` | KTX / Sleepbox | |
| `WHOLE_UNIT` | Căn hộ chung cư nguyên căn / Nhà nguyên căn | Mỗi căn/nhà = 1 đơn vị tính phí |

**Property (cụm quản lý):** một property là một cụm quản lý trong hệ thống. Cùng một địa chỉ vật lý có thể có nhiều property nếu chủ trọ tách theo loại hình hoặc cách vận hành khác nhau.

**Operating model:** trường `operatingModel` (tự sở hữu, thuê lại, quản lý hộ…) chỉ phục vụ phân loại nội bộ ở phase này; **không ảnh hưởng** đến cách tính phí subscription.

## Phòng trọ truyền thống / Căn hộ dịch vụ / KTX / Sleepbox / Nguyên căn

| Số phòng | Phí mỗi tháng |
| -------- | ------------: |
| 0–3      |      Miễn phí |
| 4–10     |      149.000đ |
| 11–25    |      349.000đ |
| 26–50    |      699.000đ |
| 51–80    |    1.119.000đ |
| 81–100   |    1.399.000đ |
| 101–150  |    2.099.000đ |
| Trên 150 |       Liên hệ |

## Chung cư / Co-living (share phòng)

Co-living vẫn tính theo **số phòng**, không tính theo giường.

| Số phòng | Phí mỗi tháng |
| -------- | ------------: |
| 0–3      |      Miễn phí |
| 4–10     |      129.000đ |
| 11–25    |      319.000đ |
| 26–50    |      629.000đ |
| 51–80    |      959.000đ |
| 81–100   |    1.199.000đ |
| 101–150  |    1.799.000đ |
| Trên 150 |       Liên hệ |

## Quy ước hệ thống

- Gói được lưu theo sức chứa: `FREE`, `ROOMS_4_10`, `ROOMS_11_25`, `ROOMS_26_50`, `ROOMS_51_80`, `ROOMS_81_100`, `ROOMS_101_150`, `ROOMS_151_PLUS`.
- Không còn khái niệm Premium hay Enterprise.
- Các loại hình phòng trọ, CHDV, KTX/Sleepbox và nguyên căn dùng bảng giá chuẩn.
- `APARTMENT` là chung cư chia sẻ phòng (co-living) và dùng bảng giá co-living. `COLIVING` cũ được tự động quy về `APARTMENT`.
- `MOTEL` đại diện chung cho phòng trọ truyền thống và căn hộ dịch vụ. `SERVICED_APARTMENT` cũ được tự động quy về `MOTEL`.
- `DORM` đại diện chung cho KTX và Sleepbox.
- `WHOLE_UNIT` đại diện cho căn hộ chung cư nguyên căn hoặc nhà nguyên căn; mỗi căn/nhà được tính là 1 đơn vị cho thuê trong hạn mức/gói.
- Khi tạo tài khoản lần đầu, Super Admin nhập số phòng đã thương lượng theo nhóm, tự chọn gói rồi cấp gói và hạn mức ban đầu.
- Với danh mục kết hợp chuẩn + co-living, hệ thống tính cả hai phương án rồi tự lấy giá thấp hơn:
  - `Gộp`: gom toàn bộ phòng, dùng bảng chuẩn nếu có ít nhất một phòng chuẩn.
  - `Tách`: tính riêng số phòng chuẩn và số phòng co-living theo từng bảng rồi cộng lại.
- Chỉ xét phương án tách khi mỗi nhóm có ít nhất 4 phòng. Mức Free chỉ áp dụng một lần cho toàn tài khoản, không thể tách 3 + 3 phòng để hưởng hai lần Free.
- Ví dụ 4 phòng chuẩn + 4 phòng co-living: giá gộp 149.000đ, giá tách 278.000đ nên lấy giá gộp.
- Ví dụ 8 phòng chuẩn + 8 phòng co-living: giá gộp 349.000đ, giá tách 278.000đ nên lấy giá tách.
- `MONTHLY` có hạn một tháng. `YEARLY` có hạn một năm và giá hiện bằng đúng 12 tháng, chưa áp dụng chiết khấu.
- Phòng trống vẫn được tính vào số phòng đang quản lý.
- Khi Super Admin duyệt, hệ thống lưu riêng hạn mức phòng chuẩn và co-living. API tạo phòng chặn cả tổng sức chứa của gói lẫn hạn mức từng nhóm; gói trả phí hết hạn cũng không được tạo thêm phòng.
- Gói trên 150 phòng chưa có giá tự động và hiển thị `Liên hệ`.

Code nguồn của bảng giá nằm tại `src/lib/server/subscription-pricing.ts`. Endpoint `GET /api/subscription/quote` trả về báo giá hiện tại của chủ trọ đang đăng nhập.

## Yêu cầu điều chỉnh gói

- Chủ trọ xem báo giá tại tab `Cài đặt → Gói Roomio`.
- `POST /api/subscription/requests` tạo một yêu cầu với gói, thời hạn và các loại hình muốn bật thêm. Mỗi tài khoản chỉ có một yêu cầu `pending` tại một thời điểm.
- Chủ trọ có thể hủy yêu cầu đang chờ bằng `PUT` với action `cancel`.
- Super Admin duyệt hoặc từ chối bằng `PUT` với action `approve` hoặc `reject`.
- Khi duyệt, hệ thống mới cập nhật gói và ngày hết hạn, đồng thời nối các loại hình được yêu cầu vào danh sách đang quản lý. Yêu cầu chỉ thêm loại hình không làm gia hạn lại gói hiện tại.
- Khi mở rộng, chủ trọ chọn từng loại hình và nhập **số phòng muốn thêm**. Hệ thống cộng phần này vào hạn mức đã duyệt, tự chọn gói mới và tính giá trước khi phòng được tạo.
- Chi tiết phần mở rộng theo từng loại hình được lưu trong `requestedRoomAdditions`; hai trường số phòng trên yêu cầu lưu hạn mức đích của nhóm chuẩn và co-living.
- Việc chỉ bật thêm loại hình với hạn mức bằng 0 không tự cộng phí, nhưng chủ trọ vẫn chưa thể tạo phòng thuộc nhóm đó.
- Nếu số phòng thực tế vượt mức đã khai báo trong lúc yêu cầu đang chờ, yêu cầu cũ không được duyệt và chủ trọ phải gửi lại để tính giá mới.
