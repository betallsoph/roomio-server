import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	requireLandlordActor,
	requireTenantActor
} from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	unauthenticatedError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import { toPaymentTransactionDto } from '$lib/server/dto/payment-transaction';
import {
	listPaymentTransactionsForLandlord,
	listPaymentTransactionsForTenant
} from '$lib/server/operations/payments';

function operationalWrongRoleResponse(actor: App.Locals['actor']) {
	if (actor?.kind === 'USER') {
		return authorizationErrorToResponse(wrongRoleError('Không có quyền xem lịch sử thanh toán'));
	}
	return authorizationErrorToResponse(unauthenticatedError());
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const status = url.searchParams.get('status');
		const actor = guard.actor;

		const landlord = requireLandlordActor(actor);
		if (landlord.ok) {
			const rows = await listPaymentTransactionsForLandlord(db, landlord.value, { status });
			return json(rows.map(toPaymentTransactionDto));
		}

		const tenant = requireTenantActor(actor);
		if (tenant.ok) {
			const rows = await listPaymentTransactionsForTenant(db, tenant.value, { status });
			return json(rows.map(toPaymentTransactionDto));
		}

		return operationalWrongRoleResponse(actor);
	} catch (error) {
		if (isAuthorizationError(error)) {
			return authorizationErrorToResponse(error);
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
