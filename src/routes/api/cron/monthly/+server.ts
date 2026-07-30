import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { properties } from '$lib/server/db/schema';
import { cleanupAutomationHistory, runAutomationJob } from '$lib/server/automation';
import { childRequestLogger, logJobEvent } from '$lib/server/logger';
import { getEnv } from '$lib/server/env';
import {
	createMachineActor,
	logMachineVerificationFailure,
	verifyCronSecret
} from '$lib/server/authorization/machine-verification';

const CRON_JOB_TYPES = [
	'overdue_sweep',
	'invoice_reminder',
	'meter_reminder',
	'contract_reminder',
	'auto_draft'
] as const;

// Cron hằng ngày — gọi từ lịch ngoài bằng header x-cron-secret. Verify trước mọi enqueue/write;
// landlord scope derive từ DB, không tin payload tự khai.

export const POST: RequestHandler = async ({ request, locals }) => {
	const log = childRequestLogger(locals.requestId, { jobType: 'cron-monthly' });
	const secret = getEnv().cronSecret;
	if (!secret) {
		return json({ error: 'CRON_SECRET chưa cấu hình trên server' }, { status: 500 });
	}
	if (!verifyCronSecret(request.headers.get('x-cron-secret'), secret)) {
		logMachineVerificationFailure(log, locals.requestId, 'CRON', 'invalid_secret');
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const actor = createMachineActor('CRON', locals.requestId);

	try {
		let body: Record<string, unknown> = {};
		try {
			body = await request.json();
		} catch {
			body = {};
		}
		const month =
			typeof body.month === 'string' ? body.month : new Date().toISOString().slice(0, 7);
		const draft = body.draft !== false;

		logJobEvent({
			requestId: locals.requestId,
			jobType: 'cron-monthly',
			outcome: 'started',
			detail: { month, draft, machineChannel: actor.channel }
		});

		const rows = await db.select({ landlordId: properties.landlordId }).from(properties);
		const landlordIds = [...new Set(rows.map((r) => r.landlordId))];

		let processed = 0;
		let draftInvoices = 0;
		const errors: string[] = [];

		for (const landlordId of landlordIds) {
			try {
				await runAutomationJob(landlordId, 'overdue_sweep');
				await runAutomationJob(landlordId, 'invoice_reminder');
				await runAutomationJob(landlordId, 'meter_reminder', { month });
				await runAutomationJob(landlordId, 'contract_reminder');
				if (draft) {
					const job = await runAutomationJob(landlordId, 'auto_draft', { month });
					const result = job.result ? JSON.parse(job.result) : {};
					draftInvoices += Number(result.draftInvoices ?? 0);
				}
				await cleanupAutomationHistory(landlordId);
				processed += 1;
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unexpected cron error';
				errors.push(`${landlordId}: ${message}`);
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
				errorCount: errors.length,
				jobTypes: draft ? CRON_JOB_TYPES : CRON_JOB_TYPES.filter((t) => t !== 'auto_draft')
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
