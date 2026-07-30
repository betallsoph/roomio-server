import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { tenantProfiles, rooms, properties, services, meterReadings } from '$lib/server/db/schema';
import { and, eq, inArray, isNotNull, like } from 'drizzle-orm';
import { forbidden, landlordOwnsTenant } from '$lib/server/authz';
import { getPaymentAccountForLandlord } from '$lib/server/payment-accounts';
import { requireLandlordActor, type LandlordActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	unauthenticatedError
} from '$lib/server/authorization/errors';
import { isTenancyDualWriteEnabled } from '$lib/server/env';
import { startTenancy } from '$lib/server/tenancies/service';
import { createManagedTenant } from '$lib/server/managed-tenants/service';
import { isManagedTenantServiceError } from '$lib/server/managed-tenants/state';
import {
	addYearsToCalendarDate,
	isTenancyServiceError,
	toTenancyErrorBody,
	todayInVietnam,
	type TenancyDto
} from '$lib/server/tenancies/state';
import { TENANT_DETAIL_WITH, toTenantSummaryDto } from '$lib/server/dto/tenants';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const landlordId =
			locals.session?.role === 'STAFF'
				? locals.session.staffLandlordId
				: locals.session?.landlordProfileId;
		if (!landlordId || (locals.session?.role !== 'LANDLORD' && locals.session?.role !== 'STAFF')) {
			return forbidden();
		}

		// Tenants that currently occupy a room in one of the landlord's properties
		const tenantIdsSubquery = db
			.select({ id: rooms.tenantId })
			.from(rooms)
			.innerJoin(properties, eq(rooms.propertyId, properties.id))
			.where(and(eq(properties.landlordId, landlordId), isNotNull(rooms.tenantId)));

		const tenants = await db.query.tenantProfiles.findMany({
			where: inArray(tenantProfiles.id, tenantIdsSubquery),
			with: TENANT_DETAIL_WITH
		});

		tenants.sort((a, b) => a.user.name.localeCompare(b.user.name, 'vi'));

		return json(tenants.map(toTenantSummaryDto));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

type CheckInResponse = {
	tenancy: TenancyDto;
	contract: { id: string | null; created: boolean; skippedReason: string | null };
	room: { id: string };
	managedTenant: { id: string };
};

/**
 * AUTH-006 — check-in mới: MỘT service duy nhất tạo Tenancy + cache tương thích + audit.
 * KHÔNG tạo `User`/`TenantProfile`: hồ sơ người thuê phải tồn tại trước dưới dạng
 * `ManagedTenant` (endpoint quản lý hồ sơ thuộc AUTH-009).
 */
async function checkInWithTenancyService(
	body: unknown,
	actor: LandlordActor,
	requestId: string
): Promise<Response> {
	const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const roomId = typeof payload.roomId === 'string' ? payload.roomId : '';
	const managedTenantId =
		typeof payload.managedTenantId === 'string' ? payload.managedTenantId : '';
	const moveInDate = payload.moveInDate;
	const deposit = payload.deposit;
	const notes = payload.notes;
	const paymentAccountId =
		typeof payload.paymentAccountId === 'string' ? payload.paymentAccountId : null;
	const initialElectricity = payload.initialElectricity;
	const initialWater = payload.initialWater;
	const contractEndDate =
		typeof payload.contractEndDate === 'string' ? payload.contractEndDate : undefined;
	const plannedEndDate = typeof payload.plannedEndDate === 'string' ? payload.plannedEndDate : null;

	if (!roomId.trim()) {
		return json({ error: 'Thiếu roomId' }, { status: 400 });
	}

	if (typeof managedTenantId !== 'string' || managedTenantId.trim() === '') {
		return json(
			{
				error: 'Cần chọn hồ sơ người thuê đã có trước khi bắt đầu lần thuê',
				code: 'MANAGED_TENANT_REQUIRED',
				requestId
			},
			{ status: 422 }
		);
	}

	// Tài khoản nhận tiền vẫn resolve bằng helper cũ (đã scope theo landlord).
	let selectedPaymentAccountId: string | null = null;
	try {
		const selectedPaymentAccount = await getPaymentAccountForLandlord(
			actor.landlordId,
			paymentAccountId || null
		);
		if (!selectedPaymentAccount.isActive) {
			return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
		}
		selectedPaymentAccountId = selectedPaymentAccount.id;
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 400 });
	}

	const startDate = typeof moveInDate === 'string' && moveInDate ? moveInDate : todayInVietnam();

	try {
		const result = await db.transaction(async (tx) => {
			const started = await startTenancy(
				tx,
				actor,
				{
					roomId,
					managedTenantId,
					startDate,
					plannedEndDate,
					depositRequired: deposit as number,
					contract: {
						// Mặc định hợp đồng 12 tháng như luồng cũ, tính trên lịch chứ không qua epoch.
						endDate: contractEndDate || addYearsToCalendarDate(startDate, 1),
						deposit: deposit as number,
						notes: typeof notes === 'string' ? notes : null,
						paymentAccountId: selectedPaymentAccountId
					}
				},
				{ requestId }
			);

			// Chỉ số đầu kỳ: giữ nguyên hành vi check-in cũ nhưng gắn snapshot tenancy.
			await recordInitialMeterReadings(tx, actor, {
				roomId: started.tenancy.roomId,
				tenancyId: started.tenancy.id,
				managedTenantId,
				month: started.tenancy.startDate.slice(0, 7),
				recordedAt: started.tenancy.startDate,
				initialElectricity,
				initialWater
			});

			return started;
		});

		const response: CheckInResponse = {
			tenancy: result.tenancy,
			contract: {
				id: result.contract.id,
				created: result.contract.created,
				skippedReason: result.contract.skippedReason
			},
			room: { id: result.tenancy.roomId },
			managedTenant: { id: managedTenantId }
		};
		return json(response, { status: 201 });
	} catch (error) {
		if (isTenancyServiceError(error)) {
			return json(toTenancyErrorBody(error, requestId), { status: error.status });
		}
		throw error;
	}
}

type InitialMeterInput = {
	roomId: string;
	tenancyId: string;
	managedTenantId: string;
	month: string;
	recordedAt: string;
	initialElectricity: unknown;
	initialWater: unknown;
};

async function recordInitialMeterReadings(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	actor: LandlordActor,
	input: InitialMeterInput
): Promise<void> {
	const entries: Array<{ pattern: string; value: unknown }> = [
		{ pattern: '%Điện%', value: input.initialElectricity },
		{ pattern: '%Nước%', value: input.initialWater }
	];

	for (const entry of entries) {
		if (entry.value === undefined || entry.value === null || entry.value === '') continue;
		const numeric = Number(entry.value);
		if (!Number.isFinite(numeric)) continue;

		const service = (
			await tx
				.select({ id: services.id })
				.from(services)
				.where(and(eq(services.landlordId, actor.landlordId), like(services.name, entry.pattern)))
				.limit(1)
		)[0];
		if (!service) continue;

		await tx.insert(meterReadings).values({
			roomId: input.roomId,
			serviceId: service.id,
			month: input.month,
			prevValue: numeric,
			currValue: numeric,
			recordedAt: input.recordedAt,
			managedTenantId: input.managedTenantId,
			tenancyId: input.tenancyId
		});
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!isTenancyDualWriteEnabled()) {
			return json(
				{
					error: 'Luồng quản lý người thuê mới chưa được bật trên môi trường này',
					code: 'TENANCY_DUAL_WRITE_DISABLED',
					requestId: locals.requestId
				},
				{ status: 503 }
			);
		}

		if (!locals.actor) {
			return authorizationErrorToResponse(unauthenticatedError());
		}
		const actorResult = requireLandlordActor(locals.actor);
		if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);

		const body = await request.json().catch(() => ({}));
		const hasRoomId = typeof body?.roomId === 'string' && body.roomId.trim() !== '';
		if (hasRoomId) {
			return await checkInWithTenancyService(body, actorResult.value, locals.requestId);
		}

		try {
			const managedTenant = await createManagedTenant(db, actorResult.value, body, {
				requestId: locals.requestId
			});
			return json(managedTenant, { status: 201 });
		} catch (error) {
			if (isManagedTenantServiceError(error)) {
				return json(
					{ error: error.message, code: error.code, requestId: locals.requestId },
					{ status: error.status }
				);
			}
			throw error;
		}
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { id, idNumber, idFrontImage, idBackImage, vehicleImage, checkInImage } = body;

		if (!id) {
			return json({ error: 'Missing tenant profile ID' }, { status: 400 });
		}

		// Khách thuê chỉ được cập nhật hồ sơ của chính mình
		if (locals.session?.role === 'TENANT' && id !== locals.session.tenantProfileId) {
			return json({ error: 'Không có quyền cập nhật hồ sơ này' }, { status: 403 });
		}
		if (
			locals.session?.role === 'LANDLORD' &&
			!(await landlordOwnsTenant(locals.session.landlordProfileId!, id))
		) {
			return forbidden();
		}

		const updateData: Record<string, unknown> = {};
		if (idNumber !== undefined) updateData.idNumber = idNumber;
		if (idFrontImage !== undefined) updateData.idFrontImage = idFrontImage;
		if (idBackImage !== undefined) updateData.idBackImage = idBackImage;
		if (vehicleImage !== undefined) updateData.vehicleImage = vehicleImage;
		if (checkInImage !== undefined) updateData.checkInImage = checkInImage;

		if (Object.keys(updateData).length > 0) {
			await db.update(tenantProfiles).set(updateData).where(eq(tenantProfiles.id, id));
		}

		const updated = await db.query.tenantProfiles.findFirst({
			where: eq(tenantProfiles.id, id),
			with: TENANT_DETAIL_WITH
		});

		return json(updated ? toTenantSummaryDto(updated) : null);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
