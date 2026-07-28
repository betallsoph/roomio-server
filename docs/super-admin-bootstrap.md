# Super Admin DB bootstrap (production)

> AUTH-002: Super Admin production phải là `User` trong PostgreSQL với `role = SUPER_ADMIN`.
> `SUPER_ADMIN_ACCOUNTS` trong env **không** tạo phiên đăng nhập ở production — chỉ phục vụ boot/preflight validation.

## Preflight checklist

- [ ] `NODE_ENV=production`
- [ ] `SESSION_SECRET` ≥ 32 ký tự, không placeholder
- [ ] `SUPER_ADMIN_ACCOUNTS` vẫn set (boot validation) — mật khẩu trong env ≥ 16 ký tự, không placeholder
- [ ] Đã tạo **ít nhất một** bản ghi `User` `SUPER_ADMIN` trong DB (bước dưới)
- [ ] Đã xác nhận đăng nhập qua `POST /api/auth` với email DB (không dùng `env-super-admin` session ID)
- [ ] Đã thu hồi thử: `isActive = false` → request API kế tiếp trả `401` và cookie bị xóa

**Không** chạy script tự động ghi production DB từ CI/deploy. Bootstrap là thao tác vận hành có kiểm soát.

## 1. Hash mật khẩu

Từ thư mục gốc API (có `node_modules`):

```bash
node --input-type=module -e "import { hashPassword } from './src/lib/server/password.ts'; console.log(await hashPassword(process.argv[1]));" 'your-strong-password'
```

## 2. Tạo bản ghi User SUPER_ADMIN

Chạy SQL trên PostgreSQL production (thay `EMAIL`, `HASH`, `NAME`):

```sql
INSERT INTO users (id, email, phone, name, password_hash, role, is_active)
VALUES (
  gen_random_uuid()::text,
  'owner@your-domain.com',
  NULL,
  'Roomio Super Admin',
  'PASTE_BCRYPT_HASH_HERE',
  'SUPER_ADMIN',
  true
);
```

Không gán `landlord_profiles` / `tenant_profiles` / `staff_profiles` cho Super Admin.

## 3. Xác minh đăng nhập

```bash
curl -sS -X POST "$ORIGIN/api/auth" \
  -H 'content-type: application/json' \
  -d '{"action":"login","email":"owner@your-domain.com","password":"your-strong-password"}'
```

Response phải có `role: SUPER_ADMIN` và `id` là UUID DB (không phải `env-super-admin`).

## Dev-only env Super Admin

Khi `NODE_ENV=development` và `SUPER_ADMIN_ACCOUNTS` được set, `allowEnvSuperAdmin=true` cho phép đăng nhập plaintext env **chỉ để dev local**. Staging/test/production luôn `allowEnvSuperAdmin=false`; session `env-super-admin` không được `getUserActor` chấp nhận và hooks chỉ bypass DB khi `isTransitionalEnvSuperAdminSession` (development only).
