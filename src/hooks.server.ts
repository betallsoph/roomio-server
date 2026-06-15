import { json, type Handle } from '@sveltejs/kit';
import { readSession } from '$lib/server/session';

// Các API không cần đăng nhập
const PUBLIC_API = ['/api/auth', '/api/payment-webhook'];

export const handle: Handle = async ({ event, resolve }) => {
	const session = readSession(event.cookies);
	event.locals.session = session;

	const { pathname } = event.url;

	if (pathname.startsWith('/api') && !PUBLIC_API.some((p) => pathname.startsWith(p))) {
		if (!session) {
			return json({ error: 'Chưa đăng nhập' }, { status: 401 });
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

		if (pathname.startsWith('/api/super-admin') && session.role !== 'SUPER_ADMIN') {
			return json({ error: 'Chỉ Super Admin được phép truy cập' }, { status: 403 });
		}
	}

	return resolve(event);
};
