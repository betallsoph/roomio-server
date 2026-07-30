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
import { operationalActorDenyReason } from '$lib/server/authorization/policies';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';
import {
	isOperationsError,
	listMeterReadingsForActor,
	resolveMeterReadingForActor,
	submitMeterReadingForActor
} from '$lib/server/operations/meter-readings';
import { toMeterReadingDto, toMeterReadingListItemDto } from '$lib/server/dto/meter-reading';

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

function operationalWrongRoleResponse(actor: App.Locals['actor']) {
	if (actor?.kind === 'USER') {
		return authorizationErrorToResponse(wrongRoleError('Không có quyền thực hiện thao tác này'));
	}
	return authorizationErrorToResponse(unauthenticatedError());
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = requireOperationalActor(locals.actor);
		if (!guard.ok) return guard.response;

		const status = url.searchParams.get('status');
		const month = url.searchParams.get('month');
		const actor = guard.actor;

		const landlord = requireLandlordActor(actor);
		if (landlord.ok) {
			const rows = await listMeterReadingsForActor(db, landlord.value, { status, month });
			return json(rows.map(toMeterReadingListItemDto));
		}
		const staff = requireStaffActor(actor);
		if (staff.ok) {
			const rows = await listMeterReadingsForActor(db, staff.value, { status, month });
			return json(rows.map(toMeterReadingListItemDto));
		}
		const tenant = requireTenantActor(actor);
		if (tenant.ok) {
			const rows = await listMeterReadingsForActor(db, tenant.value, { status, month });
			return json(rows.map(toMeterReadingListItemDto));
		}

		return operationalWrongRoleResponse(actor);
	} catch (error) {
		return mapOperationalError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = requireOperationalActor(locals.actor);
		if (!guard.ok) return guard.response;

		const body = await request.json();
		const actor = guard.actor;

		const tenant = requireTenantActor(actor);
		if (tenant.ok) {
			return json(toMeterReadingDto(await submitMeterReadingForActor(db, tenant.value, body)));
		}
		const landlord = requireLandlordActor(actor);
		if (landlord.ok) {
			return json(toMeterReadingDto(await submitMeterReadingForActor(db, landlord.value, body)));
		}

		return operationalWrongRoleResponse(actor);
	} catch (error) {
		return mapOperationalError(error);
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = requireOperationalActor(locals.actor);
		if (!guard.ok) return guard.response;

		const body = await request.json();
		const { id, action, currValue } = body;
		if (!id || !['approve', 'reject'].includes(action)) {
			return json({ error: 'Thiếu ID hoặc hành động không hợp lệ' }, { status: 400 });
		}

		const actor = guard.actor;
		const landlord = requireLandlordActor(actor);
		if (landlord.ok) {
			return json(
				toMeterReadingDto(
					await resolveMeterReadingForActor(db, landlord.value, { id, action, currValue })
				)
			);
		}
		const staff = requireStaffActor(actor);
		if (staff.ok) {
			return json(
				toMeterReadingDto(
					await resolveMeterReadingForActor(db, staff.value, { id, action, currValue })
				)
			);
		}

		return operationalWrongRoleResponse(actor);
	} catch (error) {
		return mapOperationalError(error);
	}
};
