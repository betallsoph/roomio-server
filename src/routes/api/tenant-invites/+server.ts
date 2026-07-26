import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'crypto';
import { errorMessage } from '$lib/server/api';
import { db } from '$lib/server/db';
import { tenantInvites } from '$lib/server/db/schema';
import { requireLandlord, landlordOwnsTenant, forbidden } from '$lib/server/authz';
import { getEnv } from '$lib/server/env';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

function buildDeepLink(token: string): string | null {
	const telegram = getEnv().telegram;
	if (telegram.status !== 'CONFIGURED') return null;
	return `https://t.me/${telegram.botUsername}/${telegram.miniappShortName}?startapp=${token}`;
}

// Chủ trọ sinh link mời Telegram cho 1 khách thuê. Token 1 lần, hết hạn sau 7 ngày.
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json().catch(() => null);
		const tenantId = typeof body?.tenantId === 'string' ? body.tenantId : '';
		if (!tenantId) return json({ error: 'Thiếu tenantId' }, { status: 400 });

		// Chỉ được mời khách thuê đang ở trong nhà trọ của chính mình
		if (!(await landlordOwnsTenant(auth.value, tenantId))) {
			return forbidden();
		}

		const token = crypto.randomBytes(24).toString('base64url');
		const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

		await db.insert(tenantInvites).values({
			landlordId: auth.value,
			tenantId,
			token,
			expiresAt
		});

		return json({
			token,
			link: buildDeepLink(token), // null nếu chưa cấu hình BOT_USERNAME/MINIAPP_SHORT_NAME
			expiresAt: expiresAt.toISOString()
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
