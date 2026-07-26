import { errorMessage } from '$lib/server/api';
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

export type MonthlyCronInput = {
	month?: string;
	draft?: boolean;
};

export type MonthlyCronResult = {
	success: true;
	month: string;
	landlords: number;
	processed: number;
	draftInvoices: number;
	errors: string[];
};

/** Cron hằng ngày — nhắc + quét quá hạn + tự soạn hóa đơn NHÁP. Idempotent trong ngày. */
export async function runMonthlyAutomation(
	input: MonthlyCronInput = {}
): Promise<MonthlyCronResult> {
	const month = input.month ?? new Date().toISOString().slice(0, 7);
	const draft = input.draft !== false;

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
			errors.push(`${landlordId}: ${errorMessage(err)}`);
		}
	}

	return {
		success: true,
		month,
		landlords: landlordIds.length,
		processed,
		draftInvoices,
		errors
	};
}
