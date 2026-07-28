import { json, type Handle, type HandleServerError } from '@sveltejs/kit';
import { readSession, destroySession } from '$lib/server/session';
import { rateLimit } from '$lib/server/rate-limit';
import { isPublicHealthPath } from '$lib/server/health';
import { registerProcessLifecycle } from '$lib/server/lifecycle';
import { getLogger, logHttpRequest, resolveRequestId } from '$lib/server/logger';
import {
	getUserActor,
	isTransitionalEnvSuperAdminSession
} from '$lib/server/authorization/load-user-actor';
import { isSessionExemptPublicRoute } from '$lib/server/authorization/machine-routes';
import { UnauthorizedError } from '$lib/server/authorization/errors';
import type { ActorContext } from '$lib/server/authorization/actor';

registerProcessLifecycle();

const GENERIC_SERVER_ERROR_MESSAGE = 'Đã xảy ra lỗi. Vui lòng thử lại sau.';

// Nhân viên (STAFF) chỉ được dùng đúng các API phục vụ "vận hành cơ bản" — mặc định chặn, chỉ mở những path/method dưới đây
const STAFF_ALLOWLIST: { prefix: string; methods: string[] }[] = [
	{ prefix: '/api/requests', methods: ['GET', 'PUT'] }, // xem & cập nhật sự cố được giao
	{ prefix: '/api/meter-readings', methods: ['GET', 'PUT'] }, // chốt/duyệt số điện nước
	{ prefix: '/api/rooms', methods: ['GET'] }, // xem phòng (chỉ đọc)
	{ prefix: '/api/tenants', methods: ['GET'] }, // xem khách thuê (chỉ đọc)
	{ prefix: '/api/upload', methods: ['POST'] }, // đính ảnh khi xử lý sự cố/chốt số
	{ prefix: '/api/uploads/presign', methods: ['POST'] } // xin pre-signed URL để upload thẳng R2
];

function beginRequest(event: Parameters<Handle>[0]['event']) {
	const requestId = resolveRequestId(event.request.headers.get('x-request-id'));
	event.locals.requestId = requestId;
	const startedAt = performance.now();
	const route = event.route?.id ?? event.url.pathname;

	const finish = (response: Response) => {
		const durationMs = Math.round(performance.now() - startedAt);
		logHttpRequest({
			requestId,
			method: event.request.method,
			route,
			status: response.status,
			durationMs
		});
		const headers = new Headers(response.headers);
		headers.set('x-request-id', requestId);
		if (response.status === 500) {
			headers.delete('content-length');
			headers.delete('content-encoding');
			headers.delete('content-range');
			headers.delete('etag');
			headers.set('content-type', 'application/json; charset=utf-8');
			return new Response(
				JSON.stringify({
					error: GENERIC_SERVER_ERROR_MESSAGE,
					requestId
				}),
				{
					status: 500,
					statusText: 'Internal Server Error',
					headers
				}
			);
		}
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	};

	return { requestId, finish };
}

function isUserActor(actor: ActorContext): actor is Extract<ActorContext, { kind: 'USER' }> {
	return actor.kind === 'USER';
}

export const handleError: HandleServerError = ({ error, event, status }) => {
	const requestId = event.locals.requestId ?? resolveRequestId(null);
	const route = event.route?.id ?? event.url.pathname;

	getLogger().error(
		{
			requestId,
			status,
			route,
			method: event.request.method,
			err: error
		},
		'unhandled request error'
	);

	if (status >= 500) {
		return {
			message: GENERIC_SERVER_ERROR_MESSAGE,
			requestId
		};
	}

	const message = error instanceof Error ? error.message : 'Yêu cầu không hợp lệ';
	return { message, requestId };
};

export const handle: Handle = async ({ event, resolve }) => {
	const { finish } = beginRequest(event);
	const session = readSession(event.cookies);
	event.locals.session = session;
	event.locals.actor = null;

	const { pathname } = event.url;

	if (isPublicHealthPath(pathname)) {
		if (event.request.method !== 'GET') {
			return finish(json({ error: 'Method Not Allowed' }, { status: 405 }));
		}
		return finish(await resolve(event));
	}

	if (pathname === '/api/auth' && event.request.method === 'POST') {
		const limited = rateLimit(`auth:${event.getClientAddress()}`, 20, 15 * 60 * 1000);
		if (limited) return finish(limited);
	}

	if (pathname === '/api/auth/telegram' && event.request.method === 'POST') {
		const limited = rateLimit(`tg-auth:${event.getClientAddress()}`, 30, 15 * 60 * 1000);
		if (limited) return finish(limited);
	}

	if (pathname === '/api/upload' && event.request.method === 'POST') {
		const limited = rateLimit(`upload:${event.getClientAddress()}`, 60, 60 * 60 * 1000);
		if (limited) return finish(limited);
	}

	if (pathname === '/api/uploads/presign' && event.request.method === 'POST') {
		const limited = rateLimit(`upload-presign:${event.getClientAddress()}`, 120, 60 * 60 * 1000);
		if (limited) return finish(limited);
	}

	if (pathname === '/api/payment-webhook' && event.request.method === 'POST') {
		const limited = rateLimit(`webhook:${event.getClientAddress()}`, 180, 60 * 1000);
		if (limited) return finish(limited);
	}

	if (pathname === '/api/payos-webhook' && event.request.method === 'POST') {
		const limited = rateLimit(`payos-webhook:${event.getClientAddress()}`, 180, 60 * 1000);
		if (limited) return finish(limited);
	}

	if (pathname === '/api/telegram/webhook' && event.request.method === 'POST') {
		const limited = rateLimit(`telegram-webhook:${event.getClientAddress()}`, 600, 60 * 1000);
		if (limited) return finish(limited);
	}

	if (pathname.startsWith('/api') && !isSessionExemptPublicRoute(event.request.method, pathname)) {
		if (!session) {
			return finish(json({ error: 'Chưa đăng nhập' }, { status: 401 }));
		}

		try {
			if (isTransitionalEnvSuperAdminSession(session)) {
				event.locals.actor = {
					kind: 'USER',
					userId: session.userId,
					role: 'SUPER_ADMIN'
				};
			} else {
				event.locals.actor = await getUserActor(session);
			}
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				destroySession(event.cookies);
				event.locals.actor = null;
				return finish(
					json(
						{
							error: error.message || 'Phiên đã hết hiệu lực, vui lòng đăng nhập lại'
						},
						{ status: 401 }
					)
				);
			}
			throw error;
		}

		const actor = event.locals.actor;
		if (!actor || !isUserActor(actor)) {
			destroySession(event.cookies);
			event.locals.actor = null;
			return finish(
				json({ error: 'Phiên đã hết hiệu lực, vui lòng đăng nhập lại' }, { status: 401 })
			);
		}

		// Legacy query-param scope checks (AUTH-012 sẽ thay bằng actor-scoped helpers trong endpoint)
		if (actor.role === 'LANDLORD') {
			const landlordId = event.url.searchParams.get('landlordId');
			if (landlordId && landlordId !== actor.landlordId) {
				return finish(json({ error: 'Không có quyền truy cập dữ liệu này' }, { status: 403 }));
			}
		}

		if (actor.role === 'TENANT') {
			const tenantId = event.url.searchParams.get('tenantId');
			if (tenantId && tenantId !== actor.tenantProfileId) {
				return finish(json({ error: 'Không có quyền truy cập dữ liệu này' }, { status: 403 }));
			}
		}

		if (actor.role === 'STAFF') {
			const allowed = STAFF_ALLOWLIST.some(
				(rule) => pathname.startsWith(rule.prefix) && rule.methods.includes(event.request.method)
			);
			if (!allowed) {
				return finish(
					json({ error: 'Nhân viên không có quyền thực hiện thao tác này' }, { status: 403 })
				);
			}

			const landlordId = event.url.searchParams.get('landlordId');
			if (landlordId && landlordId !== actor.landlordId) {
				return finish(json({ error: 'Không có quyền truy cập dữ liệu này' }, { status: 403 }));
			}
			const staffId = event.url.searchParams.get('staffId');
			if (staffId && staffId !== actor.staffId) {
				return finish(json({ error: 'Không có quyền truy cập dữ liệu này' }, { status: 403 }));
			}
		}

		if (pathname.startsWith('/api/super-admin') && actor.role !== 'SUPER_ADMIN') {
			return finish(json({ error: 'Chỉ Super Admin được phép truy cập' }, { status: 403 }));
		}
	}

	return finish(await resolve(event));
};
