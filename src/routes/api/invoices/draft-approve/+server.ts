import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { requireLandlordActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';
import { isOperationsError } from '$lib/server/operations/errors';
import { approveDraftInvoicesConditionally, listDraftInvoicesForApprove } from './scoped-drafts';

function mapHandlerError(error: unknown) {
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

// Duyệt hóa đơn NHÁP → 'pending': lúc này mới tính công nợ + khách mới thấy.
// Nhận { ids: string[] } hoặc { propertyId, month } để duyệt cả tòa/tháng.
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;
		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(landlord.error);
		}
		const actor = landlord.value;

		const body = await request.json();
		const ids: string[] = Array.isArray(body.ids)
			? body.ids.filter((x: unknown): x is string => typeof x === 'string')
			: [];
		const propertyId = typeof body.propertyId === 'string' ? body.propertyId : null;
		const month = typeof body.month === 'string' ? body.month : null;

		const drafts = await listDraftInvoicesForApprove(db, actor, { ids, propertyId, month });
		if (drafts.length === 0) {
			return json({ success: true, count: 0 });
		}

		const count = await approveDraftInvoicesConditionally(db, drafts);
		return json({ success: true, count });
	} catch (error) {
		return mapHandlerError(error);
	}
};
