import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { tenantProfiles, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { createSession } from '$lib/server/session';
import { verifyInitData, telegramConfigured, TelegramAuthError } from '$lib/server/telegram';
import { errorMessage } from '$lib/server/api';
import { acceptTenantInvite } from '$lib/server/tenant-invites/service';
import { isTenantInviteServiceError, toInviteErrorBody } from '$lib/server/tenant-invites/state';

async function findTenantProfileByTelegramId(telegramUserId: string) {
	return db.query.tenantProfiles.findFirst({
		where: eq(tenantProfiles.telegramUserId, telegramUserId),
		with: { user: true }
	});
}

async function ensureTelegramTenantProfile(
	telegramUserId: string,
	displayName: string
): Promise<{ userId: string; tenantProfileId: string }> {
	const existing = await findTenantProfileByTelegramId(telegramUserId);
	if (existing?.user?.isActive) {
		return { userId: existing.user.id, tenantProfileId: existing.id };
	}

	const userId = `tg-${telegramUserId}`;
	const profileId = `tg-profile-${telegramUserId}`;

	const existingUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
	if (!existingUser) {
		await db.insert(users).values({
			id: userId,
			email: `${userId}@telegram.invalid`,
			phone: telegramUserId,
			passwordHash: 'telegram-only-no-password',
			name: displayName,
			role: 'TENANT',
			isActive: true
		});
	}

	const existingProfile = await db.query.tenantProfiles.findFirst({
		where: eq(tenantProfiles.id, profileId)
	});
	if (!existingProfile) {
		await db.insert(tenantProfiles).values({
			id: profileId,
			userId,
			telegramUserId
		});
	} else if (!existingProfile.telegramUserId) {
		await db.update(tenantProfiles).set({ telegramUserId }).where(eq(tenantProfiles.id, profileId));
	}

	return { userId, tenantProfileId: profileId };
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
		const startParam =
			(typeof body?.startParam === 'string' && body.startParam) || verified.startParam;

		let tenant = await findTenantProfileByTelegramId(tgId);

		if (!tenant) {
			if (!startParam) {
				return json(
					{
						error: 'NEEDS_INVITE',
						message: 'Tài khoản Telegram chưa được liên kết. Hãy mở bằng link mời từ chủ trọ.'
					},
					{ status: 403 }
				);
			}

			const displayName =
				[verified.user.first_name, verified.user.last_name].filter(Boolean).join(' ') ||
				verified.user.username ||
				'Khách thuê Telegram';

			const identity = await ensureTelegramTenantProfile(tgId, displayName);

			try {
				await acceptTenantInvite(
					db,
					{
						token: startParam,
						actorUserId: identity.userId,
						actorTenantProfileId: identity.tenantProfileId,
						telegramUserId: tgId
					},
					{ requestId: locals.requestId }
				);
			} catch (error) {
				if (isTenantInviteServiceError(error)) {
					return json(toInviteErrorBody(error, locals.requestId), { status: error.status });
				}
				throw error;
			}

			tenant = await findTenantProfileByTelegramId(tgId);
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
