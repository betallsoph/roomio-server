import crypto from 'crypto';
import type { Cookies } from '@sveltejs/kit';

export interface SessionData {
	userId: string;
	role: string; // 'SUPER_ADMIN' | 'LANDLORD' | 'STAFF' | 'TENANT'
	landlordProfileId: string | null;
	tenantProfileId: string | null;
	staffProfileId: string | null;
}

const SECRET = process.env.SESSION_SECRET ?? 'roomio-dev-secret-change-in-production';
export const SESSION_COOKIE = 'roomio_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 ngày

function sign(payload: string): string {
	return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function createSession(cookies: Cookies, data: SessionData) {
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	cookies.set(SESSION_COOKIE, `${payload}.${sign(payload)}`, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: SESSION_MAX_AGE
	});
}

export function destroySession(cookies: Cookies) {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

export function readSession(cookies: Cookies): SessionData | null {
	const raw = cookies.get(SESSION_COOKIE);
	if (!raw) return null;

	const [payload, signature] = raw.split('.');
	if (!payload || !signature) return null;

	const expected = sign(payload);
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

	try {
		return JSON.parse(Buffer.from(payload, 'base64url').toString());
	} catch {
		return null;
	}
}
