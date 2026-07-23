# Rental type & operating model — regression checklist

Checklist chạy sau khi migration `operatingModel` (và mọi thay đổi schema liên quan rental type) đã apply trên môi trường đích. Không thay thế unit test — bổ sung smoke test tay trên sandbox/staging trước prod.

## 1. SQL verify (chạy trước & sau migrate)

```sql
-- Chỉ còn 4 giá trị canonical trên Property
SELECT "rentalType", count(*) FROM "Property" GROUP BY 1 ORDER BY 1;

-- Không còn alias cũ trên Property
SELECT count(*) FROM "Property"
WHERE "rentalType" IN ('COLIVING', 'SERVICED_APARTMENT');
-- Kỳ vọng: 0

-- operatingModel sau migration 0019
SELECT "operatingModel", count(*) FROM "Property" GROUP BY 1 ORDER BY 1;
-- Kỳ vọng row cũ: toàn UNSPECIFIED (trừ khi đã có dữ liệu test)

-- Soi alias sót trên allowlist tài khoản
SELECT "enabledRentalTypes", count(*) FROM "LandlordProfile" GROUP BY 1 ORDER BY 2 DESC;

-- Đối chiếu đếm phòng theo nhóm giá (thay :landlordId)
SELECT p."rentalType", count(r.id) AS room_count
FROM "Property" p
LEFT JOIN "Room" r ON r."propertyId" = p.id
WHERE p."landlordId" = :landlordId
GROUP BY p."rentalType"
ORDER BY 1;
```

Nếu phát hiện alias cũ trên prod → viết migration guard (template: `0011`, `0013`), không sửa tay DB.

## 2. Smoke checklist — tài khoản & allowlist

- [ ] **Landlord 1 loại hình:** Super Admin cấp chỉ `MOTEL` → chủ trọ không thấy option loại khác khi tạo property; không section header group khi chỉ có 1 loại.
- [ ] **Landlord mix loại hình:** cấp ≥ 2 loại trong `enabledRentalTypes` → trang Tòa nhà group theo section; dashboard chip breakdown (khi ≥ 2 loại có phòng) khớp `/api/dashboard/stats` → `roomBreakdownByRentalType`.

## 3. Smoke checklist — 4 loại property

Tạo một property mỗi `rentalType` được cấp:

| rentalType   | Kiểm tra                                                                          |
| ------------ | --------------------------------------------------------------------------------- |
| `MOTEL`      | Form thêm phòng đơn giản; label "phòng".                                          |
| `DORM`       | Form tương tự MOTEL; label KTX/Sleepbox.                                          |
| `APARTMENT`  | Bắt buộc block + tầng + mã căn (`roomCode`); flow "thêm phòng vào căn" hoạt động. |
| `WHOLE_UNIT` | Nút/label "căn/nhà"; **không** lộ flow thêm-vào-căn; 1 Room = 1 căn/nhà.          |

- [ ] Cả 4 loại tạo property + thêm ít nhất 1 đơn vị cho thuê thành công.
- [ ] Empty state copy đúng theo loại hình trên trang Phòng.

## 4. Smoke checklist — APARTMENT block rules

- [ ] Tạo phòng APARTMENT **thiếu** block/tầng/mã căn → API/FE chặn với message rõ.
- [ ] Thêm phòng thứ hai vào cùng mã căn (`selectedUnitCode`) → OK.
- [ ] Đổi `rentalType` property từ MOTEL → APARTMENT khi đã có phòng không đúng cấu trúc → bị chặn hoặc cần migrate phòng (theo behavior hiện tại).

## 5. Smoke checklist — WHOLE_UNIT

- [ ] UI không dùng từ "phòng" ở control chính (nút thêm, label form, toast).
- [ ] Không hiện select `roomType` / flow chọn căn có sẵn.
- [ ] Quote subscription đếm WHOLE_UNIT vào nhóm tiêu chuẩn (1 căn = 1 đơn vị).

## 6. Smoke checklist — hạn mức & enforcement

- [ ] `GET /api/subscription/quote`: `standardRoomCount` / `colivingRoomCount` khớp SQL đếm tay.
- [ ] Thêm phòng khi **đạt** `subscribedStandardRoomLimit` hoặc `subscribedColivingRoomLimit` → bị chặn, message tiếng Việt đúng nhóm.
- [ ] Thêm phòng khi **đạt** tổng sức chứa gói (`recommendedTier`) → bị chặn.
- [ ] Đổi `rentalType` property làm nhảy nhóm giá → bị chặn nếu vượt limit nhóm đích.

## 7. Smoke checklist — yêu cầu & duyệt gói

- [ ] Chủ trọ: tab Gói Roomio → gửi yêu cầu thêm loại hình + số phòng → `pending`.
- [ ] Super Admin duyệt → `enabledRentalTypes` nối thêm; `subscribedStandardRoomLimit` / `subscribedColivingRoomLimit` cập nhật đúng.
- [ ] Sau duyệt chủ trọ tạo phòng thuộc loại/nhóm mới được.

## 8. Smoke checklist — operating model (trục B)

- [ ] Tạo property không chọn model → API lưu `UNSPECIFIED`; FE không badge model.
- [ ] Sửa property → chọn `RENT_TO_RENT` → badge hiện; quote **không đổi**.
- [ ] Admin list landlord: mỗi property hiện `rentalType` + `operatingModel` (kể cả "Chưa phân loại").
- [ ] Admin khối gói: "Thực dùng X / Hạn mức Y" per nhóm; đỏ khi vượt hạn mức.

## 9. Smoke checklist — dashboard & TMA

- [ ] Dashboard web: chip breakdown chỉ khi ≥ 2 loại có count > 0; số khớp stats API.
- [ ] TMA: 4 option loại hình canonical (không `SERVICED_APARTMENT`, có `WHOLE_UNIT`).
- [ ] TMA workspace `WHOLE_UNIT`: meta nguyên căn, không fallback meta co-living.

## 10. Unit tests (CI)

```bash
cd roomio-api && npm run test
```

- [ ] Golden pricing cases pass (gồm 5 std + 2 whole + 10 col → SPLIT 278k).
- [ ] `rental-types.test.ts` alias canonical pass.

## Ghi chú

- **B5 (chưa ship):** admin hạ limit dưới số phòng thực tế — chưa có warning trong response; không block checklist trên.
- Checklist này bổ sung cho `PLAN-rental-type-operating-model.md` Phase 5.
