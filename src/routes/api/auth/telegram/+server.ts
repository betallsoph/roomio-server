import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { tenantProfiles } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { createSession } from '$lib/server/session';
import { verifyInitData, telegramConfigured, TelegramAuthError } from '$lib/server/telegram';
import { errorMessage } from '$lib/server/api';
import { claimTenantInviteViaTelegram } from '$lib/server/tenant-invites/service';
import { isTenantInviteServiceError, toInviteErrorBody } from '$lib/server/tenant-invites/state';

async function findTenantProfileByTelegramId(telegramUserId: string) {
	return db.query.tenantProfiles.findFirst({
		where: eq(tenantProfiles.telegramUserId, telegramUserId),
		with: { user: true }
	});
}

function tenantDisplayName(user: {
	first_name?: string;
	last_name?: string;
	username?: string;
}): string {
	return (
		[user.first_name, user.last_name].filter(Boolean).join(' ') ||
		user.username ||
		'Khách thuê Telegram'
	);
}

// Đăng nhập khách thuê từ Telegram Mini App: verify initData → claim ManagedTenant qua invite.
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
	try {
		if (!telegramConfigured()) {
			return json({ error: 'Server chưa cấu hình BOT_TOKEN' }, { status: 503 });
		}

		const body = await request.json().catch(() => null);
		const initData = typeof body?.initData === 'string' ? body.initData : '';

		let verified;
		try {
			verified = verifyInitData(initData);
		} catch (e) {
			if (e instanceof TelegramAuthError) return json({ error: e.message }, { status: 401 });
			throw e;
		}

		const tgId = String(verified.user.id);
		// AUTH-009: invite token MUST come from signed initData only — never from request body.
		const startParam = verified.startParam;

		let tenant = await findTenantProfileByTelegramId(tgId);

		if (startParam) {
			try {
				const claimed = await claimTenantInviteViaTelegram(
					db,
					{
						token: startParam,
						telegramUserId: tgId,
						displayName: tenantDisplayName(verified.user)
					},
					{ requestId: locals.requestId }
				);
				tenant = await findTenantProfileByTelegramId(tgId);
				if (!tenant) {
					tenant = await db.query.tenantProfiles.findFirst({
						where: eq(tenantProfiles.id, claimed.tenantProfileId),
						with: { user: true }
					});
				}
			} catch (error) {
				if (isTenantInviteServiceError(error)) {
					return json(toInviteErrorBody(error, locals.requestId), { status: error.status });
				}
				throw error;
			}
		} else if (!tenant) {
			return json(
				{
					error: 'NEEDS_INVITE',
					message: 'Tài khoản Telegram chưa được liên kết. Hãy mở bằng link mời từ chủ trọ.'
				},
				{ status: 403 }
			);
		}

		if (!tenant?.user || !tenant.user.isActive) {
			return json({ error: 'Tài khoản đã bị tạm khóa' }, { status: 403 });
		}

		createSession(cookies, {
			userId: tenant.user.id,
			role: tenant.user.role,
			landlordProfileId: null,
			enabledRentalTypes: null,
			tenantProfileId: tenant.id,
			staffProfileId: null,
			staffLandlordId: null
		});

		return json({
			id: tenant.user.id,
			name: tenant.user.name,
			role: tenant.user.role,
			tenantProfileId: tenant.id
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
