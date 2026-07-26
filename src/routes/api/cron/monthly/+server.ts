import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { properties } from '$lib/server/db/schema';
import {
	cleanupAutomationHistory,
	generateDraftInvoices,
	queueContractReminders,
	queueInvoiceReminders,
	queueMeterReminders,
	runOverdueSweep
} from '$lib/server/automation';
import { childRequestLogger, logJobEvent } from '$lib/server/logger';
import { getEnv } from '$lib/server/env';

// Cron hằng ngày — gọi từ lịch ngoài (GitHub Actions / crontab) bằng header x-cron-secret.
// Chạy nhắc + quét quá hạn + tự soạn hóa đơn NHÁP cho mọi chủ trọ. Không có session người dùng.
// Idempotent: nhắc/nháp đều chống trùng, nên chạy lại trong ngày vô hại.
export const POST: RequestHandler = async ({ request, locals }) => {
	const log = childRequestLogger(locals.requestId, { jobType: 'cron-monthly' });
	const secret = getEnv().cronSecret;
	if (!secret) {
		return json({ error: 'CRON_SECRET chưa cấu hình trên server' }, { status: 500 });
	}
	if (request.headers.get('x-cron-secret') !== secret) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		let body: Record<string, unknown> = {};
		try {
			body = await request.json();
		} catch {
			body = {};
		}
		const month =
			typeof body.month === 'string' ? body.month : new Date().toISOString().slice(0, 7);
		const draft = body.draft !== false; // mặc định soạn nháp; truyền {"draft":false} để chỉ chạy nhắc

		logJobEvent({
			requestId: locals.requestId,
			jobType: 'cron-monthly',
			outcome: 'started',
			detail: { month, draft }
		});

		const rows = await db.select({ landlordId: properties.landlordId }).from(properties);
		const landlordIds = [...new Set(rows.map((r) => r.landlordId))];

		let processed = 0;
		let draftInvoices = 0;
		const errors: string[] = [];

		for (const landlordId of landlordIds) {
			try {
				await runOverdueSweep(landlordId);
				await queueInvoiceReminders(landlordId);
				await queueMeterReminders(landlordId, month);
				await queueContractReminders(landlordId);
				if (draft) {
					const r = await generateDraftInvoices(landlordId, month);
					draftInvoices += r.draftInvoices;
				}
				await cleanupAutomationHistory(landlordId);
				processed += 1;
			} catch (err) {
				// Một chủ trọ lỗi không được chặn cả mẻ
				errors.push(`${landlordId}: ${errorMessage(err)}`);
			}
		}

		logJobEvent({
			requestId: locals.requestId,
			jobType: 'cron-monthly',
			outcome: 'completed',
			detail: {
				month,
				landlords: landlordIds.length,
				processed,
				draftInvoices,
				errorCount: errors.length
			}
		});

		return json({
			success: true,
			month,
			landlords: landlordIds.length,
			processed,
			draftInvoices,
			errors
		});
	} catch (error) {
		log.error({ err: error }, 'cron monthly job failed');
		logJobEvent({
			requestId: locals.requestId,
			jobType: 'cron-monthly',
			outcome: 'failed'
		});
		return json(
			{ error: 'Đã xảy ra lỗi. Vui lòng thử lại sau.', requestId: locals.requestId },
			{ status: 500 }
		);
	}
};
