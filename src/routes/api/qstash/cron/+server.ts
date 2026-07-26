import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import { runMonthlyAutomation, type MonthlyCronInput } from '$lib/server/cron-monthly';
import { isQStashConfigured, verifyQStashRequest } from '$lib/server/qstash';
import type { RequestHandler } from './$types';

function parseBody(raw: string): MonthlyCronInput {
	if (!raw.trim()) return {};
	try {
		const body = JSON.parse(raw) as Record<string, unknown>;
		return {
			month: typeof body.month === 'string' ? body.month : undefined,
			draft: typeof body.draft === 'boolean' ? body.draft : body.draft === false ? false : undefined
		};
	} catch {
		return {};
	}
}

// Cron hằng ngày — gọi từ Upstash QStash schedule (verify chữ ký, không dùng session).
export const POST: RequestHandler = async ({ request }) => {
	if (!isQStashConfigured()) {
		return json(
			{ error: 'QStash chưa cấu hình (QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY)' },
			{ status: 503 }
		);
	}

	const body = await request.text();

	try {
		const verified = await verifyQStashRequest(request, body);
		if (!verified.ok) {
			return json({ error: verified.error }, { status: verified.status });
		}

		const result = await runMonthlyAutomation(parseBody(body));
		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
