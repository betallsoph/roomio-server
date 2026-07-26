# Log rotation — OBS-001 defaults

Roomio API ghi log JSON ra **stdout** (một object mỗi dòng). Process Node không tự rotate file; host hoặc container driver phải giới hạn dung lượng.

## Giá trị mặc định an toàn

| Tham số                | Mặc định | Ghi chú                   |
| ---------------------- | -------- | ------------------------- |
| `maxFileSizeMb`        | 50       | Mỗi file trước khi rotate |
| `rotatedFilesToKeep`   | 14       | ~2 tuần nếu rotate daily  |
| `retentionDays`        | 30       | Xóa archive cũ hơn        |
| `compressRotated`      | true     | Tiết kiệm disk            |
| `diskUsageWarnPercent` | 80       | Cảnh báo ops (OBS-003)    |

Các hằng số nằm trong `src/lib/server/logger/rotation.ts` và được test tự động.

## Ví dụ logrotate trên A1-APP

```conf
/var/log/roomio/api.log {
    daily
    rotate 14
    maxsize 50M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

## Docker / journald

- Giới hạn driver logging (`max-size`, `max-file`) nếu container ghi ra json-file.
- Không mount volume log không giới hạn trên root disk.

## Biến môi trường

- `LOG_LEVEL` — tùy chọn (`info` production, `debug` local). Không ảnh hưởng rotation.

Triển khai rotation thực tế trên server thuộc runbook ops; ticket OBS-001 chỉ chuẩn hóa logger và document defaults.
