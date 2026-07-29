import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	users,
	tenantProfiles,
	rooms,
	properties,
	services,
	meterReadings,
	contracts
} from '$lib/server/db/schema';
import { and, eq, inArray, isNotNull, like, or } from 'drizzle-orm';
import { hashPassword } from '$lib/server/password';
import {
	forbidden,
	landlordOwnsRoom,
	landlordOwnsTenant,
	requireLandlord
} from '$lib/server/authz';
import { getPaymentAccountForLandlord } from '$lib/server/payment-accounts';
import { requireLandlordActor, type LandlordActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	unauthenticatedError
} from '$lib/server/authorization/errors';
import { isTenancyDualWriteEnabled } from '$lib/server/env';
import { hasActiveTenancyForRoom, startTenancy } from '$lib/server/tenancies/service';
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
	const plannedEndDate =
		typeof payload.plannedEndDate === 'string' ? payload.plannedEndDate : null;

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
		// AUTH-006 / AUTH-009 — khi flag bật, POST phân nhánh theo body:
		// - `roomId` + `managedTenantId` → check-in (startTenancy)
		// - `displayName` → tạo ManagedTenant (không tạo/link User từ contact)
		if (isTenancyDualWriteEnabled()) {
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
		}

		// Luồng legacy (flag off) — giữ nguyên đến khi AUTH-009 thay identity/invite.
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const {
			email,
			phone,
			password,
			name,
			roomId,
			idNumber,
			moveInDate,
			deposit,
			notes,
			initialElectricity,
			initialWater,
			paymentAccountId
		} = body;

		if (
			!email ||
			!phone ||
			!password ||
			!name ||
			!roomId ||
			!idNumber ||
			!moveInDate ||
			deposit === undefined
		) {
			return json({ error: 'Thiếu thông tin khách thuê bắt buộc' }, { status: 400 });
		}
		if (!(await landlordOwnsRoom(auth.value, roomId))) {
			return forbidden();
		}
		// AUTH-006 — chống split-brain khi rollback flag: phòng đã có Tenancy ACTIVE thì
		// luồng legacy KHÔNG được tạo thêm occupant/identity đè lên lần thuê canonical.
		if (await hasActiveTenancyForRoom(db, roomId)) {
			return json(
				{
					error: 'Phòng đang có lần thuê hiệu lực',
					code: 'ROOM_OCCUPIED',
					requestId: locals.requestId
				},
				{ status: 409 }
			);
		}
		const selectedPaymentAccount = await getPaymentAccountForLandlord(
			auth.value,
			paymentAccountId || null
		);
		if (!selectedPaymentAccount.isActive) {
			return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
		}

		// 1. Check if user already exists
		const existingUser = await db.query.users.findFirst({
			where: or(eq(users.email, email), eq(users.phone, phone))
		});

		const newUserHash = existingUser ? null : await hashPassword(password);

		const tenant = await db.transaction(async (tx) => {
			const user =
				existingUser ??
				(
					await tx
						.insert(users)
						.values({ email, phone, passwordHash: newUserHash!, name, role: 'TENANT' })
						.returning()
				)[0];

			// 2. Check if TenantProfile exists
			let tenantProfile = (
				await tx.select().from(tenantProfiles).where(eq(tenantProfiles.userId, user.id))
			)[0];

			if (!tenantProfile) {
				tenantProfile = (
					await tx
						.insert(tenantProfiles)
						.values({ userId: user.id, idNumber, moveInDate, deposit: Number(deposit), notes })
						.returning()
				)[0];
			} else {
				// Update details if profile already exists
				tenantProfile = (
					await tx
						.update(tenantProfiles)
						.set({ idNumber, moveInDate, deposit: Number(deposit), notes })
						.where(eq(tenantProfiles.id, tenantProfile.id))
						.returning()
				)[0];
			}

			// 3. Link room to tenant
			const room = (
				await tx
					.update(rooms)
					.set({
						tenantId: tenantProfile.id,
						status: 'paid', // Mark as active/paid initially
						debtAmount: 0,
						paymentAccountId: selectedPaymentAccount.id
					})
					.where(eq(rooms.id, roomId))
					.returning()
			)[0];

			const property = (
				await tx
					.select({ landlordId: properties.landlordId })
					.from(properties)
					.where(eq(properties.id, room.propertyId))
			)[0];

			// 4. Record initial meters
			const checkInMonth = moveInDate.slice(0, 7); // "YYYY-MM"
			const today = new Date().toISOString().split('T')[0];

			if (property) {
				// Find electricity & water services for the landlord
				const electricityService = (
					await tx
						.select()
						.from(services)
						.where(and(eq(services.landlordId, property.landlordId), like(services.name, '%Điện%')))
				)[0];
				const waterService = (
					await tx
						.select()
						.from(services)
						.where(and(eq(services.landlordId, property.landlordId), like(services.name, '%Nước%')))
				)[0];

				if (electricityService && initialElectricity !== undefined) {
					await tx.insert(meterReadings).values({
						roomId: room.id,
						serviceId: electricityService.id,
						month: checkInMonth,
						prevValue: Number(initialElectricity),
						currValue: Number(initialElectricity),
						recordedAt: today
					});
				}

				if (waterService && initialWater !== undefined) {
					await tx.insert(meterReadings).values({
						roomId: room.id,
						serviceId: waterService.id,
						month: checkInMonth,
						prevValue: Number(initialWater),
						currValue: Number(initialWater),
						recordedAt: today
					});
				}
			}

			// 5. Create a 12-month rental contract by default
			const start = new Date(moveInDate);
			const end = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
			await tx.insert(contracts).values({
				tenantId: tenantProfile.id,
				roomId: room.id,
				startDate: moveInDate,
				endDate: end.toISOString().split('T')[0],
				monthlyRent: room.monthlyRent,
				deposit: Number(deposit),
				paymentAccountId: selectedPaymentAccount.id,
				notes: notes || null,
				status: 'active'
			});

			return tenantProfile;
		});

		const fullTenant = await db.query.tenantProfiles.findFirst({
			where: eq(tenantProfiles.id, tenant.id),
			with: TENANT_DETAIL_WITH
		});

		return json(fullTenant ? toTenantSummaryDto(fullTenant) : null);
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
