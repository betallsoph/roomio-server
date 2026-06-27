import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { getPlatformPayOSConfig, verifyPayOSWebhook } from '$lib/server/payos';

// Webhook cho dòng tiền chủ trọ → SuperAdmin (phí subscription). Đây là merchant DUY NHẤT của
// nền tảng nên verify bằng key NỀN TẢNG (env), khác hẳn webhook tiền thuê (key từng chủ trọ).
// TODO: khi có luồng thu subscription, áp kết quả vào bản ghi subscription tương ứng tại đây.

export const POST: RequestHandler = async ({ request }) => {
	try {
		const config = getPlatformPayOSConfig();
		if (!config) {
			return json({ error: 'Chưa cấu hình PayOS nền tảng' }, { status: 500 });
		}

		const body = await request.json();
		const { data, signature } = body;
		if (!data || typeof data !== 'object' || !signature) {
			return json({ error: 'Payload PayOS không hợp lệ' }, { status: 400 });
		}
		if (!verifyPayOSWebhook(data, String(signature), config.checksumKey)) {
			return json({ error: 'Sai chữ ký PayOS' }, { status: 401 });
		}

		// Chưa có luồng thu subscription — ack để PayOS không retry.
		return json({ success: true, message: 'Subscription webhook nhận (chưa xử lý)' });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
