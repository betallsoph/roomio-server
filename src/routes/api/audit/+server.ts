import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizationErrorToResponse } from '$lib/server/authorization/errors';
import { requireLandlordActor } from '$lib/server/authorization/actor';
import { db } from '$lib/server/db';
import { listLandlordAuditEvents, type AuditListResult } from '$lib/server/audit/query';
import type { AuditEventDto } from '$lib/server/audit/dto';
import { errorMessage } from '$lib/server/api';
import { ValidationError } from '$lib/server/validation';
import { AuditValidationError } from '$lib/server/audit/metadata';

export type { AuditEventDto, AuditListResult };

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const actor = locals.actor;
		if (!actor) {
			return json({ error: 'Chưa đăng nhập' }, { status: 401 });
		}

		const guard = requireLandlordActor(actor);
		if (!guard.ok) {
			return authorizationErrorToResponse(guard.error);
		}

		const limitParam = url.searchParams.get('limit');
		const limit =
			limitParam === null || limitParam === ''
				? undefined
				: Number.isFinite(Number(limitParam))
					? Number(limitParam)
					: undefined;

		const result = await listLandlordAuditEvents(db, {
			landlordId: guard.value.landlordId,
			limit,
			cursor: url.searchParams.get('cursor')
		});

		return json(result);
	} catch (error) {
		if (error instanceof ValidationError || error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
