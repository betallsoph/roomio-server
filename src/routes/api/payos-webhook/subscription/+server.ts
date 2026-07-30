import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlatformPayOSConfig, verifyPayOSWebhook } from '$lib/server/payos';
import { childRequestLogger } from '$lib/server/logger';
import {
	createMachineActor,
	logMachineVerificationFailure,
	parsePayOSWebhookBody
} from '$lib/server/authorization/machine-verification';

// Webhook cho dòng tiền chủ trọ → SuperAdmin (phí subscription). Merchant DUY NHẤT của nền tảng —
// verify bằng key NỀN TẢNG (env) trước mọi business parsing/write.

export const POST: RequestHandler = async ({ request, locals }) => {
	const log = childRequestLogger(locals.requestId, { handler: 'payos-subscription-webhook' });

	try {
		const config = getPlatformPayOSConfig();
		if (!config) {
			return json({ error: 'Chưa cấu hình PayOS nền tảng' }, { status: 503 });
		}

		const body = await request.json();
		const parsed = parsePayOSWebhookBody(body);
		if (!parsed) {
			logMachineVerificationFailure(log, locals.requestId, 'PAYMENT_WEBHOOK', 'invalid_payload', {
				route: 'subscription'
			});
			return json({ error: 'Payload PayOS không hợp lệ' }, { status: 400 });
		}

		if (!verifyPayOSWebhook(parsed.data, parsed.signature, config.checksumKey)) {
			logMachineVerificationFailure(log, locals.requestId, 'PAYMENT_WEBHOOK', 'invalid_signature', {
				route: 'subscription'
			});
			return json({ error: 'Sai chữ ký PayOS' }, { status: 401 });
		}

		const actor = createMachineActor('PAYMENT_WEBHOOK', locals.requestId, {
			verifiedAccountId: 'platform'
		});
		log.info(
			{ machineChannel: actor.channel, outcome: 'verified' },
			'subscription webhook verified'
		);

		// Chưa có luồng thu subscription — ack để PayOS không retry.
		return json({ success: true, message: 'Subscription webhook nhận (chưa xử lý)' });
	} catch (error) {
		log.error({ err: error }, 'payos subscription webhook failed');
		return json(
			{ error: 'Đã xảy ra lỗi. Vui lòng thử lại sau.', requestId: locals.requestId },
			{ status: 500 }
		);
	}
};
