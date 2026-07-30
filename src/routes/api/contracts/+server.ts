import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { contracts, managedTenants, rooms, properties } from '$lib/server/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { toContractDto } from '$lib/server/dto/contract';
import { getPaymentAccountForLandlord } from '$lib/server/payment-accounts';
import { requireLandlordActor, requireTenantActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	unauthenticatedError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';
import { isTenancyDualWriteEnabled } from '$lib/server/env';
import {
	createContractForActiveTenancy,
	hasActiveTenancyForRoom
} from '$lib/server/tenancies/service';
import { isTenancyServiceError, toTenancyErrorBody } from '$lib/server/tenancies/state';
import {
	deleteContractForLandlord,
	listContractsForLandlord,
	listContractsForTenant,
	resolveContractPaymentAccount,
	updateContractForLandlord
} from './scope';

function mapContractRouteError(error: unknown, requestId?: string): Response | null {
	if (error instanceof ScopedResourceNotFoundError) {
		return json({ error: error.message }, { status: 404 });
	}
	if (isAuthorizationError(error)) {
		return authorizationErrorToResponse(error);
	}
	if (isTenancyServiceError(error)) {
		return json(toTenancyErrorBody(error, requestId), { status: error.status });
	}
	return null;
}

function operationalWrongRoleResponse(actor: App.Locals['actor']) {
	if (actor?.kind === 'USER') {
		return authorizationErrorToResponse(wrongRoleError('Không có quyền thực hiện thao tác này'));
	}
	return authorizationErrorToResponse(unauthenticatedError());
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const tenantProfileId = url.searchParams.get('tenantId');
		const actor = guard.actor;

		const landlord = requireLandlordActor(actor);
		if (landlord.ok) {
			const rows = await listContractsForLandlord(db, landlord.value, {
				tenantProfileId: tenantProfileId || null
			});
			return json(rows.map(toContractDto));
		}

		const tenant = requireTenantActor(actor);
		if (tenant.ok) {
			const rows = await listContractsForTenant(db, tenant.value);
			return json(rows.map(toContractDto));
		}

		return operationalWrongRoleResponse(actor);
	} catch (error) {
		const mapped = mapContractRouteError(error, locals.requestId);
		if (mapped) return mapped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

/**
 * Chọn tài khoản nhận tiền cho hợp đồng: ưu tiên body, rồi tới tài khoản của phòng, rồi
 * mặc định của chủ trọ. Truy vấn phòng luôn scope theo landlord nên phòng của chủ khác
 * không lộ dữ liệu — service tenancy vẫn là nơi trả 404.
 */
async function resolveRoomPaymentAccount(
	landlordId: string,
	roomId: unknown,
	requestedPaymentAccountId: unknown
): Promise<{ paymentAccountId: string } | { response: Response }> {
	try {
		const scopedRoom =
			typeof roomId === 'string' && roomId
				? (
						await db
							.select({ paymentAccountId: rooms.paymentAccountId })
							.from(rooms)
							.innerJoin(properties, eq(rooms.propertyId, properties.id))
							.where(and(eq(rooms.id, roomId), eq(properties.landlordId, landlordId)))
							.limit(1)
					)[0]
				: undefined;

		const account = await getPaymentAccountForLandlord(
			landlordId,
			(typeof requestedPaymentAccountId === 'string' && requestedPaymentAccountId
				? requestedPaymentAccountId
				: scopedRoom?.paymentAccountId) || null
		);
		if (!account.isActive) {
			return { response: json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 }) };
		}
		return { paymentAccountId: account.id };
	} catch (error) {
		return { response: json({ error: errorMessage(error) }, { status: 400 }) };
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;
		const actorResult = requireLandlordActor(guard.actor);
		if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);
		const actor = actorResult.value;

		const body = await request.json();
		const {
			tenantId,
			roomId,
			startDate,
			endDate,
			monthlyRent,
			deposit,
			fileUrl,
			notes,
			paymentAccountId
		} = body ?? {};

		if (isTenancyDualWriteEnabled()) {
			const roomPaymentAccount = await resolveRoomPaymentAccount(
				actor.landlordId,
				roomId,
				paymentAccountId
			);
			if ('response' in roomPaymentAccount) return roomPaymentAccount.response;

			const contract = await createContractForActiveTenancy(db, actor, {
				roomId,
				startDate,
				endDate,
				monthlyRent,
				deposit,
				fileUrl,
				notes,
				paymentAccountId: roomPaymentAccount.paymentAccountId,
				expectedLegacyTenantProfileId: tenantId ?? null
			});
			return json(contract, { status: 201 });
		}

		if (!tenantId || !roomId || !startDate || !endDate || monthlyRent === undefined) {
			return json({ error: 'Thiếu thông tin hợp đồng bắt buộc' }, { status: 400 });
		}

		if (await hasActiveTenancyForRoom(db, roomId)) {
			const roomPaymentAccount = await resolveRoomPaymentAccount(
				actor.landlordId,
				roomId,
				paymentAccountId
			);
			if ('response' in roomPaymentAccount) return roomPaymentAccount.response;

			const contract = await createContractForActiveTenancy(db, actor, {
				roomId,
				startDate,
				endDate,
				monthlyRent,
				deposit,
				fileUrl,
				notes,
				paymentAccountId: roomPaymentAccount.paymentAccountId,
				expectedLegacyTenantProfileId: tenantId
			});
			return json(contract, { status: 201 });
		}

		const room = await db.query.rooms.findFirst({
			where: and(
				eq(rooms.id, roomId),
				inArray(
					rooms.id,
					db
						.select({ id: rooms.id })
						.from(rooms)
						.innerJoin(properties, eq(rooms.propertyId, properties.id))
						.where(eq(properties.landlordId, actor.landlordId))
				)
			),
			columns: { paymentAccountId: true }
		});
		if (!room) {
			return json({ error: 'Không tìm thấy' }, { status: 404 });
		}

		const ownsTenant = await db.query.managedTenants.findFirst({
			where: and(
				eq(managedTenants.landlordId, actor.landlordId),
				eq(managedTenants.legacyTenantProfileId, tenantId)
			),
			columns: { id: true }
		});
		if (!ownsTenant) {
			return json({ error: 'Không tìm thấy' }, { status: 404 });
		}

		const selectedPaymentAccount = await getPaymentAccountForLandlord(
			actor.landlordId,
			paymentAccountId || room.paymentAccountId || null
		);
		if (!selectedPaymentAccount.isActive) {
			return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
		}

		const created = await db
			.insert(contracts)
			.values({
				tenantId,
				roomId,
				startDate,
				endDate,
				monthlyRent: Number(monthlyRent),
				deposit: deposit !== undefined ? Number(deposit) : 0,
				fileUrl: fileUrl || null,
				paymentAccountId: selectedPaymentAccount.id,
				notes: notes || null,
				status: 'active'
			})
			.returning();

		return json(toContractDto(created[0]));
	} catch (error) {
		const mapped = mapContractRouteError(error, locals.requestId);
		if (mapped) return mapped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;
		const actorResult = requireLandlordActor(guard.actor);
		if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);
		const actor = actorResult.value;

		const body = await request.json();
		const {
			id,
			startDate,
			endDate,
			monthlyRent,
			deposit,
			fileUrl,
			notes,
			status,
			paymentAccountId
		} = body;

		if (!id) {
			return json({ error: 'Missing contract ID' }, { status: 400 });
		}

		const updateData: Record<string, unknown> = {};
		if (startDate !== undefined) updateData.startDate = startDate;
		if (endDate !== undefined) updateData.endDate = endDate;
		if (monthlyRent !== undefined) updateData.monthlyRent = Number(monthlyRent);
		if (deposit !== undefined) updateData.deposit = Number(deposit);
		if (fileUrl !== undefined) updateData.fileUrl = fileUrl;
		if (notes !== undefined) updateData.notes = notes;
		if (status !== undefined) updateData.status = status;
		if (paymentAccountId !== undefined) {
			try {
				updateData.paymentAccountId = await resolveContractPaymentAccount(
					db,
					actor,
					paymentAccountId || null
				);
			} catch (error) {
				const mapped = mapContractRouteError(error, locals.requestId);
				if (mapped) return mapped;
				return json({ error: errorMessage(error) }, { status: 400 });
			}
		}

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		const updated = await updateContractForLandlord(db, actor, id, updateData);
		return json(toContractDto(updated));
	} catch (error) {
		const mapped = mapContractRouteError(error, locals.requestId);
		if (mapped) return mapped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;
		const actorResult = requireLandlordActor(guard.actor);
		if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);
		const actor = actorResult.value;

		const id = url.searchParams.get('id');
		if (!id) {
			return json({ error: 'Missing contract ID' }, { status: 400 });
		}

		await deleteContractForLandlord(db, actor, id);
		return json({ success: true });
	} catch (error) {
		const mapped = mapContractRouteError(error, locals.requestId);
		if (mapped) return mapped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
