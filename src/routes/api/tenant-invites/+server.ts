import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errorMessage } from '$lib/server/api';
import { db } from '$lib/server/db';
import { requireLandlordActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	unauthenticatedError
} from '$lib/server/authorization/errors';
import { issueTenantInvite } from '$lib/server/tenant-invites/service';
import { isTenantInviteServiceError, toInviteErrorBody } from '$lib/server/tenant-invites/state';

// Chủ trọ sinh link mời Telegram bound landlord + managed tenant + active tenancy.
// Plaintext token chỉ trả đúng một lần; DB lưu hash.
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!locals.actor) {
			return authorizationErrorToResponse(unauthenticatedError());
		}
		const actorResult = requireLandlordActor(locals.actor);
		if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);

		const body = await request.json().catch(() => null);
		const managedTenantId = typeof body?.managedTenantId === 'string' ? body.managedTenantId : '';
		const tenancyId = typeof body?.tenancyId === 'string' ? body.tenancyId : '';

		try {
			const issued = await issueTenantInvite(
				db,
				actorResult.value,
				{ managedTenantId, tenancyId },
				{ requestId: locals.requestId }
			);
			return json({
				token: issued.token,
				link: issued.link,
				expiresAt: issued.expiresAt,
				inviteId: issued.inviteId
			});
		} catch (error) {
			if (isTenantInviteServiceError(error)) {
				return json(toInviteErrorBody(error, locals.requestId), { status: error.status });
			}
			throw error;
		}
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
