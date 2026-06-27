# TMA Upload Ảnh Qua Cloudflare R2

Luồng chuẩn:

1. TMA nén ảnh trên client thành JPEG/WebP nhỏ hơn `maxSize`.
2. TMA gọi `roomio-api` để xin pre-signed URL.
3. TMA `PUT` blob ảnh trực tiếp lên Cloudflare R2 bằng URL vừa nhận.
4. TMA gửi nghiệp vụ về `roomio-api` kèm `publicUrl` hoặc `url` để API lưu DB.

## Endpoint xin URL upload

`POST /api/uploads/presign`

Yêu cầu: đã đăng nhập, có cookie session Roomio. Với TMA, nên gọi qua cùng origin `/api/...` để cookie first-party chạy ổn.

Body:

```json
{
	"purpose": "meter-reading",
	"contentType": "image/jpeg",
	"byteSize": 248120
}
```

`purpose` hiện hỗ trợ:

- `meter-reading`
- `maintenance-request`
- `tenant-document`
- `payment-proof`
- `contract`
- `room-asset`

Response:

```json
{
	"uploadUrl": "https://<account>.r2.cloudflarestorage.com/...",
	"method": "PUT",
	"headers": {
		"Content-Type": "image/jpeg"
	},
	"objectKey": "uploads/meters/tenant/<tenantId>/2026/06/<uuid>.jpg",
	"publicUrl": "https://assets.roomio.vn/uploads/meters/tenant/<tenantId>/2026/06/<uuid>.jpg",
	"url": "https://assets.roomio.vn/uploads/meters/tenant/<tenantId>/2026/06/<uuid>.jpg",
	"expiresIn": 300,
	"maxSize": 5242880
}
```

## Code mẫu cho TMA

```ts
async function uploadImageToR2(blob: Blob, purpose = 'meter-reading') {
	const presignRes = await fetch('/api/uploads/presign', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({
			purpose,
			contentType: blob.type || 'image/jpeg',
			byteSize: blob.size
		})
	});

	const presign = await presignRes.json();
	if (!presignRes.ok) throw new Error(presign.error || 'Không xin được link upload');

	const uploadRes = await fetch(presign.uploadUrl, {
		method: 'PUT',
		headers: presign.headers,
		body: blob
	});

	if (!uploadRes.ok) throw new Error('Upload ảnh lên R2 thất bại');

	return presign.publicUrl || presign.url;
}
```

Gửi chỉ số sau khi upload:

```ts
const photoUrl = await uploadImageToR2(compressedBlob, 'meter-reading');

await fetch('/api/meter-readings', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	credentials: 'include',
	body: JSON.stringify({
		roomId,
		serviceId,
		month,
		currValue,
		photoUrl
	})
});
```

## Cấu hình R2 bucket

`roomio-api` cần các env:

```bash
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=roomio-uploads
R2_PUBLIC_BASE_URL=https://assets.roomio.vn
R2_PRESIGN_EXPIRES_SECONDS=300
R2_UPLOAD_MAX_BYTES=5242880
```

Bucket R2 cần CORS cho browser upload bằng pre-signed URL:

```json
[
	{
		"AllowedOrigins": ["https://tma.roomio.vn", "http://localhost:5173"],
		"AllowedMethods": ["PUT"],
		"AllowedHeaders": ["Content-Type"],
		"ExposeHeaders": ["ETag"],
		"MaxAgeSeconds": 3600
	}
]
```

Lưu ý: `uploadUrl` luôn là domain S3 API của R2, dạng `<account_id>.r2.cloudflarestorage.com`. `publicUrl` mới là domain public/custom domain để app hiển thị ảnh.

## Prompt đưa cho AI bên TMA

Implement upload ảnh thật cho `roomio-tma` theo flow R2 pre-signed URL:

- Dùng file input/camera hiện có, nén ảnh client-side thành JPEG/WebP trước khi upload.
- Gọi `POST /api/uploads/presign` với `{ purpose, contentType, byteSize }`, `credentials: 'include'`.
- Upload blob bằng `fetch(uploadUrl, { method: 'PUT', headers, body: blob })`.
- Không gửi file qua `roomio-api`; chỉ gửi metadata nghiệp vụ sau khi R2 upload thành công.
- Với chốt số điện/nước, sau upload gọi `POST /api/meter-readings` kèm `photoUrl = presign.publicUrl`.
- Nếu presign hết hạn hoặc upload fail, báo lỗi và cho người dùng bấm gửi lại.
- Không hardcode Cloudflare key trong TMA. Secret chỉ nằm trong `roomio-api`.
- Giữ API calls qua `/api/...` cùng origin để cookie Roomio hoạt động trong Telegram Mini App.
