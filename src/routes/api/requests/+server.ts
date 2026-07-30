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
	unauthenticatedError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';
import {
	createMaintenanceRequestForActor,
	deleteMaintenanceRequestForActor,
	isOperationsError,
	listMaintenanceRequestsForActor,
	updateMaintenanceRequestForActor
} from '$lib/server/operations/maintenance-requests';
import { toMaintenanceRequestDto } from '$lib/server/dto/maintenance-request';

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

function operationalWrongRoleResponse(actor: App.Locals['actor']) {
	if (actor?.kind === 'USER') {
		return authorizationErrorToResponse(wrongRoleError('Không có quyền thực hiện thao tác này'));
	}
	return authorizationErrorToResponse(unauthenticatedError());
}

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			const rows = await listMaintenanceRequestsForActor(db, landlord.value);
			return json(rows.map(toMaintenanceRequestDto));
		}
		const staff = requireStaffActor(guard.actor);
		if (staff.ok) {
			const rows = await listMaintenanceRequestsForActor(db, staff.value);
			return json(rows.map(toMaintenanceRequestDto));
		}
		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			const rows = await listMaintenanceRequestsForActor(db, tenant.value);
			return json(rows.map(toMaintenanceRequestDto));
		}

		return operationalWrongRoleResponse(guard.actor);
	} catch (error) {
		return mapOperationalError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const tenant = requireTenantActor(guard.actor);
		if (!tenant.ok) {
			return operationalWrongRoleResponse(guard.actor);
		}

		const body = await request.json();
		const created = await createMaintenanceRequestForActor(db, tenant.value, body);
		return json(toMaintenanceRequestDto(created));
	} catch (error) {
		return mapOperationalError(error);
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const body = await request.json();
		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			return json(
				toMaintenanceRequestDto(await updateMaintenanceRequestForActor(db, landlord.value, body))
			);
		}
		const staff = requireStaffActor(guard.actor);
		if (staff.ok) {
			return json(
				toMaintenanceRequestDto(await updateMaintenanceRequestForActor(db, staff.value, body))
			);
		}

		return operationalWrongRoleResponse(guard.actor);
	} catch (error) {
		return mapOperationalError(error);
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const id = url.searchParams.get('id');
		if (!id) {
			return json({ error: 'Missing maintenance request ID' }, { status: 400 });
		}

		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return operationalWrongRoleResponse(guard.actor);
		}

		await deleteMaintenanceRequestForActor(db, landlord.value, id);
		return json({ success: true });
	} catch (error) {
		return mapOperationalError(error);
	}
};
