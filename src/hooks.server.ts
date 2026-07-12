import { json, type Handle } from '@sveltejs/kit';
import { readSession, destroySession } from '$lib/server/session';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { rateLimit } from '$lib/server/rate-limit';

// Các API không cần đăng nhập
const PUBLIC_API = [
	'/api/auth',
	'/api/payment-webhook',
	'/api/payos-webhook',
	'/api/telegram/webhook',
	'/api/cron' // tự bảo vệ bằng header x-cron-secret === CRON_SECRET, không dùng session
];

function isEnvSuperAdminSession(session: NonNullable<ReturnType<typeof readSession>>) {
	return (
		session.role === 'SUPER_ADMIN' &&
		(session.userId === 'env-super-admin' ||
			session.userId.startsWith('env-super-admin:') ||
			session.userId === 'hardcoded-super-admin')
	);
}

// Nhân viên (STAFF) chỉ được dùng đúng các API phục vụ "vận hành cơ bản" — mặc định chặn, chỉ mở những path/method dưới đây
const STAFF_ALLOWLIST: { prefix: string; methods: string[] }[] = [
	{ prefix: '/api/requests', methods: ['GET', 'PUT'] }, // xem & cập nhật sự cố được giao
	{ prefix: '/api/meter-readings', methods: ['GET', 'PUT'] }, // chốt/duyệt số điện nước
	{ prefix: '/api/rooms', methods: ['GET'] }, // xem phòng (chỉ đọc)
	{ prefix: '/api/tenants', methods: ['GET'] }, // xem khách thuê (chỉ đọc)
	{ prefix: '/api/upload', methods: ['POST'] }, // đính ảnh khi xử lý sự cố/chốt số
	{ prefix: '/api/uploads/presign', methods: ['POST'] } // xin pre-signed URL để upload thẳng R2
];

export const handle: Handle = async ({ event, resolve }) => {
	const session = readSession(event.cookies);
	event.locals.session = session;

	const { pathname } = event.url;

	if (pathname === '/api/auth' && event.request.method === 'POST') {
		const limited = rateLimit(`auth:${event.getClientAddress()}`, 20, 15 * 60 * 1000);
		if (limited) return limited;
	}

	if (pathname === '/api/auth/telegram' && event.request.method === 'POST') {
		const limited = rateLimit(`tg-auth:${event.getClientAddress()}`, 30, 15 * 60 * 1000);
		if (limited) return limited;
	}

	if (pathname === '/api/upload' && event.request.method === 'POST') {
		const limited = rateLimit(`upload:${event.getClientAddress()}`, 60, 60 * 60 * 1000);
		if (limited) return limited;
	}

	if (pathname === '/api/uploads/presign' && event.request.method === 'POST') {
		const limited = rateLimit(`upload-presign:${event.getClientAddress()}`, 120, 60 * 60 * 1000);
		if (limited) return limited;
	}

	if (pathname === '/api/payment-webhook' && event.request.method === 'POST') {
		const limited = rateLimit(`webhook:${event.getClientAddress()}`, 180, 60 * 1000);
		if (limited) return limited;
	}

	if (pathname === '/api/payos-webhook' && event.request.method === 'POST') {
		const limited = rateLimit(`payos-webhook:${event.getClientAddress()}`, 180, 60 * 1000);
		if (limited) return limited;
	}

	if (pathname === '/api/telegram/webhook' && event.request.method === 'POST') {
		const limited = rateLimit(`telegram-webhook:${event.getClientAddress()}`, 600, 60 * 1000);
		if (limited) return limited;
	}

	if (pathname.startsWith('/api') && !PUBLIC_API.some((p) => pathname.startsWith(p))) {
		if (!session) {
			return json({ error: 'Chưa đăng nhập' }, { status: 401 });
		}

		// Super Admin nằm trong env, không có bản ghi User trong DB. Hỗ trợ cả ID phiên cũ để
		// những phiên được tạo trước lần chuyển đổi này không bị đăng xuất giữa chừng.
		if (!isEnvSuperAdminSession(session)) {
			// Phiên có thể thu hồi: xác thực lại danh tính với DB mỗi request, để việc khóa tài khoản
			// (isActive=false) hoặc đổi quyền có hiệu lực NGAY thay vì chờ cookie hết hạn (tối đa 7 ngày).
			const account = await db.query.users.findFirst({
				where: eq(users.id, session.userId),
				columns: { isActive: true, role: true }
			});
			if (!account || !account.isActive) {
				destroySession(event.cookies);
				return json({ error: 'Phiên đã hết hiệu lực, vui lòng đăng nhập lại' }, { status: 401 });
			}
			if (account.role !== session.role) {
				destroySession(event.cookies);
				return json(
					{ error: 'Quyền truy cập đã thay đổi, vui lòng đăng nhập lại' },
					{ status: 401 }
				);
			}
		}

		// Chặn truy cập chéo dữ liệu: ID trên query param phải khớp với phiên đăng nhập
		if (session.role === 'LANDLORD') {
			const landlordId = event.url.searchParams.get('landlordId');
			if (landlordId && landlordId !== session.landlordProfileId) {
				return json({ error: 'Không có quyền truy cập dữ liệu này' }, { status: 403 });
			}
		}

		if (session.role === 'TENANT') {
			const tenantId = event.url.searchParams.get('tenantId');
			if (tenantId && tenantId !== session.tenantProfileId) {
				return json({ error: 'Không có quyền truy cập dữ liệu này' }, { status: 403 });
			}
		}

		if (session.role === 'STAFF') {
			// Mặc định chặn: chỉ cho qua path/method nằm trong allowlist
			const allowed = STAFF_ALLOWLIST.some(
				(rule) => pathname.startsWith(rule.prefix) && rule.methods.includes(event.request.method)
			);
			if (!allowed) {
				return json({ error: 'Nhân viên không có quyền thực hiện thao tác này' }, { status: 403 });
			}

			// Nhân viên chỉ thao tác trong phạm vi chủ trọ của mình và trên dữ liệu của chính mình
			const landlordId = event.url.searchParams.get('landlordId');
			if (landlordId && landlordId !== session.staffLandlordId) {
				return json({ error: 'Không có quyền truy cập dữ liệu này' }, { status: 403 });
			}
			const staffId = event.url.searchParams.get('staffId');
			if (staffId && staffId !== session.staffProfileId) {
				return json({ error: 'Không có quyền truy cập dữ liệu này' }, { status: 403 });
			}
		}

		if (pathname.startsWith('/api/super-admin') && session.role !== 'SUPER_ADMIN') {
			return json({ error: 'Chỉ Super Admin được phép truy cập' }, { status: 403 });
		}
	}

	return resolve(event);
};
