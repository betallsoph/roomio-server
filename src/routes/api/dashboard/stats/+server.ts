import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { getDashboardStats } from '$lib/server/aggregate-scope';
import { toDashboardStatsDto } from '$lib/server/dto/dashboard-stats';
import { requireLandlordMutationActor } from '$lib/server/property-scope';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const stats = await getDashboardStats(actorResult.actor.landlordId);
		return json(toDashboardStatsDto(stats));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
