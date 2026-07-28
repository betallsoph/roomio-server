import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errorMessage } from '$lib/server/api';
import { db } from '$lib/server/db';
import {
	grantStaffPermission,
	revokeStaffPermission,
	replaceStaffPermissionsAllowlist,
	listStaffAssignmentsPermissions
} from '$lib/server/staff/assignments';
import {
	resolveLandlordActorFromRequest,
	staffRouteErrorResponse
} from '$lib/server/staff/landlord-request';
import { AuditValidationError } from '$lib/server/audit/metadata';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const guard = resolveLandlordActorFromRequest({
			actor: locals.actor,
			session: locals.session
		});
		if (!guard.ok) {
			return guard.response;
		}

		const body = await request.json();
		const permission = typeof body?.permission === 'string' ? body.permission.trim() : '';
		if (!permission) {
			return json({ error: 'Thiếu permission' }, { status: 400 });
		}

		const result = await grantStaffPermission(db, guard.actor, {
			staffId: params.id,
			permission
		});

		return json({ permission: result.value, changed: result.changed });
	} catch (error) {
		const mapped = staffRouteErrorResponse(error);
		if (mapped) return mapped;
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const guard = resolveLandlordActorFromRequest({
			actor: locals.actor,
			session: locals.session
		});
		if (!guard.ok) {
			return guard.response;
		}

		const body = await request.json();
		if (!Array.isArray(body?.permissions)) {
			return json({ error: 'Thiếu permissions (mảng)' }, { status: 400 });
		}

		const result = await replaceStaffPermissionsAllowlist(db, guard.actor, {
			staffId: params.id,
			permissions: body.permissions
		});

		const snapshot = await listStaffAssignmentsPermissions(
			params.id,
			guard.actor.landlordId,
			db
		);

		return json({
			granted: result.granted,
			revoked: result.revoked,
			permissions: snapshot.permissions
		});
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
		const guard = resolveLandlordActorFromRequest({
			actor: locals.actor,
			session: locals.session
		});
		if (!guard.ok) {
			return guard.response;
		}

		const permission = url.searchParams.get('permission')?.trim() ?? '';
		if (!permission) {
			return json({ error: 'Thiếu permission' }, { status: 400 });
		}

		const result = await revokeStaffPermission(db, guard.actor, {
			staffId: params.id,
			permission
		});

		return json({ permission: result.value, changed: result.changed });
	} catch (error) {
		const mapped = staffRouteErrorResponse(error);
		if (mapped) return mapped;
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
