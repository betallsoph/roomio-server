import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { tenantProfiles, tenantInvites } from '$lib/server/db/schema';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createSession } from '$lib/server/session';
import { verifyInitData, telegramConfigured, TelegramAuthError } from '$lib/server/telegram';
import { errorMessage } from '$lib/server/api';

// Đăng nhập khách thuê từ Telegram Mini App: verify initData → tìm hồ sơ theo telegramUserId.
// Lần đầu chưa liên kết thì cần token mời (start_param) do chủ trọ sinh từ dashboard.
export const POST: RequestHandler = async ({ request, cookies }) => {
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

		// 1) Đã liên kết trước đó → đăng nhập thẳng
		let tenant = await db.query.tenantProfiles.findFirst({
			where: eq(tenantProfiles.telegramUserId, tgId),
			with: { user: true }
		});

		// 2) Chưa liên kết → bắt buộc có token mời còn hiệu lực
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

			const invite = await db.query.tenantInvites.findFirst({
				where: and(
					eq(tenantInvites.token, startParam),
					isNull(tenantInvites.usedAt),
					gt(tenantInvites.expiresAt, new Date())
				)
			});
			if (!invite) {
				return json({ error: 'Link mời không hợp lệ hoặc đã hết hạn' }, { status: 403 });
			}

			const target = await db.query.tenantProfiles.findFirst({
				where: eq(tenantProfiles.id, invite.tenantId),
				with: { user: true }
			});
			if (!target) {
				return json({ error: 'Hồ sơ khách thuê không tồn tại' }, { status: 404 });
			}
			if (target.telegramUserId && target.telegramUserId !== tgId) {
				return json(
					{ error: 'Hồ sơ này đã được liên kết với một tài khoản Telegram khác' },
					{ status: 409 }
				);
			}

			await db
				.update(tenantProfiles)
				.set({ telegramUserId: tgId })
				.where(eq(tenantProfiles.id, target.id));
			await db
				.update(tenantInvites)
				.set({ usedAt: new Date() })
				.where(eq(tenantInvites.id, invite.id));

			tenant = target;
		}

		if (!tenant.user || !tenant.user.isActive) {
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
