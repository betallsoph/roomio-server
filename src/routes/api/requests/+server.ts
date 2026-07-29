import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	requireLandlordActor,
	requireStaffActor,
	requireTenantActor
} from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	unauthenticatedError
} from '$lib/server/authorization/errors';
import { operationalActorDenyReason } from '$lib/server/authorization/policies';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';
import {
	createMaintenanceRequestForActor,
	deleteMaintenanceRequestForActor,
	isOperationsError,
	listMaintenanceRequestsForActor,
	updateMaintenanceRequestForActor
} from '$lib/server/operations/maintenance-requests';

function mapOperationalError(error: unknown) {
	if (error instanceof ScopedResourceNotFoundError) {
		return json({ error: error.message }, { status: 404 });
	}
	if (isAuthorizationError(error)) {
		return authorizationErrorToResponse(error);
	}
	if (isOperationsError(error)) {
		return json({ error: error.message }, { status: error.status });
	}
	return json({ error: errorMessage(error) }, { status: 500 });
}

function requireOperationalActor(actor: App.Locals['actor']) {
	if (!actor || operationalActorDenyReason(actor)) {
		return { ok: false as const, response: authorizationErrorToResponse(unauthenticatedError()) };
	}
	return { ok: true as const, actor };
}

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const guard = requireOperationalActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			return json(await listMaintenanceRequestsForActor(db, landlord.value));
		}
		const staff = requireStaffActor(guard.actor);
		if (staff.ok) {
			return json(await listMaintenanceRequestsForActor(db, staff.value));
		}
		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			return json(await listMaintenanceRequestsForActor(db, tenant.value));
		}

		return authorizationErrorToResponse(unauthenticatedError());
	} catch (error) {
		return mapOperationalError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = requireOperationalActor(locals.actor);
		if (!guard.ok) return guard.response;

		const tenant = requireTenantActor(guard.actor);
		if (!tenant.ok) {
			return authorizationErrorToResponse(unauthenticatedError());
		}

		const body = await request.json();
		const created = await createMaintenanceRequestForActor(db, tenant.value, body);
		return json(created);
	} catch (error) {
		return mapOperationalError(error);
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = requireOperationalActor(locals.actor);
		if (!guard.ok) return guard.response;

		const body = await request.json();
		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			return json(await updateMaintenanceRequestForActor(db, landlord.value, body));
		}
		const staff = requireStaffActor(guard.actor);
		if (staff.ok) {
			return json(await updateMaintenanceRequestForActor(db, staff.value, body));
		}

		return authorizationErrorToResponse(unauthenticatedError());
	} catch (error) {
		return mapOperationalError(error);
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = requireOperationalActor(locals.actor);
		if (!guard.ok) return guard.response;

		const id = url.searchParams.get('id');
		if (!id) {
			return json({ error: 'Missing maintenance request ID' }, { status: 400 });
		}

		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(unauthenticatedError());
		}

		await deleteMaintenanceRequestForActor(db, landlord.value, id);
		return json({ success: true });
	} catch (error) {
		return mapOperationalError(error);
	}
};
