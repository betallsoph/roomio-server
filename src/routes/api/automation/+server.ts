import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { automationJobs, notificationQueue } from '$lib/server/db/schema';
import { cleanupAutomationHistory, runAutomationJob } from '$lib/server/automation';
import { toAutomationOverviewDto } from '$lib/server/dto/automation';
import { requireLandlordMutationActor } from '$lib/server/property-scope';
import { and, desc, eq } from 'drizzle-orm';

const ALLOWED_ACTIONS = [
	'overdue_sweep',
	'invoice_reminder',
	'meter_reminder',
	'contract_reminder',
	'auto_draft',
	'run_all'
] as const;

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const [jobs, queuedNotifications] = await Promise.all([
			db.query.automationJobs.findMany({
				where: eq(automationJobs.landlordId, landlordId),
				orderBy: desc(automationJobs.createdAt),
				limit: 20,
				columns: {
					id: true,
					type: true,
					status: true,
					scheduledFor: true,
					startedAt: true,
					completedAt: true,
					result: true,
					createdAt: true
				}
			}),
			db.query.notificationQueue.findMany({
				where: and(
					eq(notificationQueue.landlordId, landlordId),
					eq(notificationQueue.status, 'queued')
				),
				orderBy: desc(notificationQueue.createdAt),
				limit: 50,
				columns: {
					id: true,
					type: true,
					status: true,
					title: true,
					content: true,
					createdAt: true
				}
			})
		]);

		return json(toAutomationOverviewDto({ jobs, queuedNotifications }));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const body = await request.json();
		const action = String(body.action ?? '');
		if (!ALLOWED_ACTIONS.includes(action as (typeof ALLOWED_ACTIONS)[number])) {
			return json({ error: 'Automation không hợp lệ' }, { status: 400 });
		}

		const month =
			typeof body.month === 'string' ? body.month : new Date().toISOString().slice(0, 7);
		const actions =
			action === 'run_all'
				? ALLOWED_ACTIONS.filter((item) => item !== 'run_all' && item !== 'auto_draft')
				: [action];

		await cleanupAutomationHistory(landlordId);

		const jobs = [];
		for (const type of actions) {
			jobs.push(await runAutomationJob(landlordId, type, { month }));
		}

		return json({ success: true, jobs });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
