import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import type { SessionData } from '$lib/server/session';
import { db } from '$lib/server/db';
import { landlordProfiles, paymentAccounts } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { encryptSecret } from '$lib/server/secrets';
import { confirmPayOSWebhook } from '$lib/server/payos';
import { ensureDefaultPaymentAccount } from '$lib/server/payment-accounts';

// URL webhook tiền thuê — phải trỏ về box API (không phải frontend). PayOS sẽ ping thử URL này.
function apiWebhookUrl() {
	const origin = (
		process.env.ORIGIN ??
		process.env.PUBLIC_APP_ORIGIN ??
		'http://localhost:3000'
	).replace(/\/$/, '');
	return `${origin}/api/payos-webhook`;
}

// Quyền: LANDLORD chỉ cấu hình PayOS của CHÍNH MÌNH; SUPER_ADMIN cấu hình cho landlordId bất kỳ.
function resolveTargetLandlordId(
	session: SessionData | null,
	bodyLandlordId?: string | null
): { ok: true; id: string } | { ok: false; response: Response } {
	if (session?.role === 'LANDLORD' && session.landlordProfileId) {
		return { ok: true, id: session.landlordProfileId };
	}
	if (session?.role === 'SUPER_ADMIN') {
		if (!bodyLandlordId)
			return { ok: false, response: json({ error: 'Thiếu landlordId' }, { status: 400 }) };
		return { ok: true, id: bodyLandlordId };
	}
	return { ok: false, response: json({ error: 'Không có quyền cấu hình PayOS' }, { status: 403 }) };
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const target = resolveTargetLandlordId(locals.session, url.searchParams.get('landlordId'));
		if (!target.ok) return target.response;

		const profile = await db.query.landlordProfiles.findFirst({
			where: eq(landlordProfiles.id, target.id),
			columns: { payosClientId: true, payosConnectedAt: true }
		});
		return json({
			connected: !!profile?.payosClientId,
			clientId: profile?.payosClientId ?? null, // clientId không bí mật, trả về để đối chiếu
			connectedAt: profile?.payosConnectedAt ?? null
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const action = body.action ?? 'connect';
		const target = resolveTargetLandlordId(locals.session, body.landlordId);
		if (!target.ok) return target.response;

		if (action === 'disconnect') {
			const account = await ensureDefaultPaymentAccount(target.id);
			await db.transaction(async (tx) => {
				await tx
					.update(landlordProfiles)
					.set({
						payosClientId: null,
						payosApiKeyEnc: null,
						payosChecksumKeyEnc: null,
						payosConnectedAt: null
					})
					.where(eq(landlordProfiles.id, target.id));
				await tx
					.update(paymentAccounts)
					.set({
						provider: 'vietqr',
						payosClientId: null,
						payosApiKeyEnc: null,
						payosChecksumKeyEnc: null,
						payosConnectedAt: null
					})
					.where(eq(paymentAccounts.id, account.id));
			});
			return json({ connected: false });
		}

		const clientId = String(body.clientId ?? '').trim();
		const apiKey = String(body.apiKey ?? '').trim();
		const checksumKey = String(body.checksumKey ?? '').trim();
		if (!clientId || !apiKey || !checksumKey) {
			return json({ error: 'Cần đủ clientId, apiKey và checksumKey' }, { status: 400 });
		}

		const apiKeyEnc = encryptSecret(apiKey);
		const checksumKeyEnc = encryptSecret(checksumKey);
		const connectedAt = new Date();
		const account = await ensureDefaultPaymentAccount(target.id);
		await db.transaction(async (tx) => {
			await tx
				.update(landlordProfiles)
				.set({
					payosClientId: clientId,
					payosApiKeyEnc: apiKeyEnc,
					payosChecksumKeyEnc: checksumKeyEnc,
					payosConnectedAt: connectedAt
				})
				.where(eq(landlordProfiles.id, target.id));
			await tx
				.update(paymentAccounts)
				.set({
					provider: 'payos',
					payosClientId: clientId,
					payosApiKeyEnc: apiKeyEnc,
					payosChecksumKeyEnc: checksumKeyEnc,
					payosConnectedAt: connectedAt
				})
				.where(eq(paymentAccounts.id, account.id));
		});

		// Đăng ký webhook (vừa validate key vừa set URL). Ở dev localhost PayOS không gọi tới được
		// → cảnh báo chứ không chặn; key vẫn lưu để lên prod test lại.
		let webhookRegistered = false;
		let warning: string | null = null;
		try {
			await confirmPayOSWebhook({ clientId, apiKey, checksumKey }, apiWebhookUrl());
			webhookRegistered = true;
		} catch (e) {
			warning = errorMessage(e);
		}

		return json({ connected: true, webhookRegistered, webhookUrl: apiWebhookUrl(), warning });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
