import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { getFinanceSummary } from '$lib/server/aggregate-scope';
import { toFinanceSummaryDto } from '$lib/server/dto/finance';
import { requireLandlordMutationActor } from '$lib/server/property-scope';

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const monthCount = Math.min(Number(url.searchParams.get('months')) || 6, 24);
		const summary = await getFinanceSummary(actorResult.actor.landlordId, monthCount);
		return json(toFinanceSummaryDto(summary));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
