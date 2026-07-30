import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { requireOperationalActor } from '$lib/server/property-scope';
import {
	findManagedTenantDetailForActor,
	tenantScopeErrorToResponse
} from '$lib/server/tenant-scope';

/** `tenantId` path param is ManagedTenant.id (API compatibility). */
export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const detail = await findManagedTenantDetailForActor(db, actorResult.actor, params.tenantId);
		return json(detail);
	} catch (error) {
		const scoped = tenantScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
