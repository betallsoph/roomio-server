import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { requireLandlordActor, requireTenantActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	unauthenticatedError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import { isCommunicationsError } from '$lib/server/communications/errors';
import {
	createSpecialNoteForActor,
	listSpecialNotesForLandlord,
	listSpecialNotesForTenant,
	markSpecialNoteReadForActor
} from '$lib/server/communications/notifications';

function mapCommunicationsError(error: unknown) {
	if (isCommunicationsError(error)) {
		return json({ error: error.message }, { status: error.status });
	}
	if (isAuthorizationError(error)) {
		return authorizationErrorToResponse(error);
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

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			return json(await listSpecialNotesForTenant(db, tenant.value));
		}

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			return json(await listSpecialNotesForLandlord(db, landlord.value));
		}

		return operationalWrongRoleResponse(guard.actor);
	} catch (error) {
		return mapCommunicationsError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const body = await request.json();
		const content = typeof body.content === 'string' ? body.content : '';
		if (!content) {
			return json({ error: 'Missing tenant ID or content' }, { status: 400 });
		}

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			const created = await createSpecialNoteForActor(db, tenant.value, {
				tenancyId: body.tenancyId,
				content
			});
			return json(created);
		}

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			const created = await createSpecialNoteForActor(db, landlord.value, {
				managedTenantId: body.managedTenantId ?? body.tenantId,
				tenancyId: body.tenancyId,
				content
			});
			return json(created);
		}

		return operationalWrongRoleResponse(guard.actor);
	} catch (error) {
		return mapCommunicationsError(error);
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const body = await request.json();
		const id = typeof body.id === 'string' ? body.id : '';
		if (!id) {
			return json({ error: 'Missing notification/note ID' }, { status: 400 });
		}

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			const updated = await markSpecialNoteReadForActor(
				db,
				tenant.value,
				id,
				body.isRead !== undefined ? body.isRead : true
			);
			return json(updated);
		}

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			const updated = await markSpecialNoteReadForActor(
				db,
				landlord.value,
				id,
				body.isRead !== undefined ? body.isRead : true
			);
			return json(updated);
		}

		return operationalWrongRoleResponse(guard.actor);
	} catch (error) {
		return mapCommunicationsError(error);
	}
};
