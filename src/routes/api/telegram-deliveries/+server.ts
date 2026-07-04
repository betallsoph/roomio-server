import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import { requireLandlord } from '$lib/server/authz';
import {
	listTelegramDeliveries,
	retryPendingTelegramDeliveries,
	retryTelegramDelivery
} from '$lib/server/message-delivery';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const limit = Number(url.searchParams.get('limit') ?? 20);
		const deliveries = await listTelegramDeliveries(auth.value, limit);

		return json(deliveries);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json().catch(() => null);
		const action = typeof body?.action === 'string' ? body.action : 'retry';

		if (action === 'retry_all') {
			const results = await retryPendingTelegramDeliveries(auth.value, Number(body?.limit ?? 10));
			return json({ success: true, results });
		}

		const id = typeof body?.id === 'string' ? body.id : '';
		if (!id) return json({ error: 'Thiếu notification id' }, { status: 400 });

		const result = await retryTelegramDelivery(auth.value, id);
		if (!result) return json({ error: 'Không tìm thấy delivery Telegram' }, { status: 404 });

		return json({ success: result.delivered, result });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
