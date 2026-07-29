import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errorMessage } from '$lib/server/api';
import { db } from '$lib/server/db';
import { assignStaffProperty, revokeStaffProperty } from '$lib/server/staff/assignments';
import {
	resolveLandlordActorFromRequest,
	staffRouteErrorResponse
} from '$lib/server/staff/landlord-request';
import { AuditValidationError } from '$lib/server/audit/metadata';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const guard = resolveLandlordActorFromRequest({ actor: locals.actor });
		if (!guard.ok) {
			return guard.response;
		}

		const body = await request.json();
		const propertyId = typeof body?.propertyId === 'string' ? body.propertyId.trim() : '';
		if (!propertyId) {
			return json({ error: 'Thiếu propertyId' }, { status: 400 });
		}

		const result = await assignStaffProperty(db, guard.actor, {
			staffId: params.id,
			propertyId
		});

		return json({ assignment: result.value, changed: result.changed });
	} catch (error) {
		const mapped = staffRouteErrorResponse(error);
		if (mapped) return mapped;
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const guard = resolveLandlordActorFromRequest({ actor: locals.actor });
		if (!guard.ok) {
			return guard.response;
		}

		const propertyId = url.searchParams.get('propertyId')?.trim() ?? '';
		if (!propertyId) {
			return json({ error: 'Thiếu propertyId' }, { status: 400 });
		}

		const result = await revokeStaffProperty(db, guard.actor, {
			staffId: params.id,
			propertyId
		});

		return json({ assignment: result.value, changed: result.changed });
	} catch (error) {
		const mapped = staffRouteErrorResponse(error);
		if (mapped) return mapped;
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
