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
import { and, eq, like, or } from 'drizzle-orm';
import { hashPassword } from '$lib/server/password';
import { forbidden, landlordOwnsRoom, requireLandlord } from '$lib/server/authz';
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
import type { SessionData } from '$lib/server/session';
import { requireOperationalActor } from '$lib/server/property-scope';
import {
	findManagedTenantDetailForActor,
	listManagedTenantsForActor,
	tenantScopeErrorToResponse
} from '$lib/server/tenant-scope';
import {
	findManagedTenantForLandlord,
	findManagedTenantForTenant
} from '$lib/server/authorization/scoped-queries';
import { appendAudit, auditActorFromUserActor } from '$lib/server/audit';
import { AuditValidationError } from '$lib/server/audit/metadata';
import { isLandlordActor, isTenantActor } from '$lib/server/property-scope/actor';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const result = await listManagedTenantsForActor(db, actorResult.actor);
		return json(result);
	} catch (error) {
		const scoped = tenantScopeErrorToResponse(error);
		if (scoped) return scoped;
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

async function legacyCheckIn(
	body: unknown,
	locals: { session: SessionData | null; requestId: string }
) {
	const auth = requireLandlord(locals.session);
	if (!auth.ok) return auth.response;

	const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const email = payload.email;
	const phone = payload.phone;
	const password = payload.password;
	const name = payload.name;
	const roomId = payload.roomId;
	const idNumber = payload.idNumber;
	const moveInDate = payload.moveInDate;
	const deposit = payload.deposit;
	const notes = payload.notes;
	const initialElectricity = payload.initialElectricity;
	const initialWater = payload.initialWater;
	const paymentAccountId =
		typeof payload.paymentAccountId === 'string' ? payload.paymentAccountId : null;

	if (
		typeof email !== 'string' ||
		typeof phone !== 'string' ||
		typeof password !== 'string' ||
		typeof name !== 'string' ||
		typeof roomId !== 'string' ||
		typeof idNumber !== 'string' ||
		typeof moveInDate !== 'string' ||
		deposit === undefined
	) {
		return json({ error: 'Thiếu thông tin khách thuê bắt buộc' }, { status: 400 });
	}
	if (!(await landlordOwnsRoom(auth.value, roomId))) {
		return forbidden();
	}
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

		let tenantProfile = (
			await tx.select().from(tenantProfiles).where(eq(tenantProfiles.userId, user.id))
		)[0];

		if (!tenantProfile) {
			tenantProfile = (
				await tx
					.insert(tenantProfiles)
					.values({
						userId: user.id,
						idNumber,
						moveInDate,
						deposit: Number(deposit),
						notes: typeof notes === 'string' ? notes : null
					})
					.returning()
			)[0];
		} else {
			tenantProfile = (
				await tx
					.update(tenantProfiles)
					.set({
						idNumber,
						moveInDate,
						deposit: Number(deposit),
						notes: typeof notes === 'string' ? notes : null
					})
					.where(eq(tenantProfiles.id, tenantProfile.id))
					.returning()
			)[0];
		}

		const room = (
			await tx
				.update(rooms)
				.set({
					tenantId: tenantProfile.id,
					status: 'paid',
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

		const checkInMonth = moveInDate.slice(0, 7);
		const today = new Date().toISOString().split('T')[0];

		if (property) {
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
			notes: typeof notes === 'string' ? notes : null,
			status: 'active'
		});

		return tenantProfile;
	});

	const fullTenant = await db.query.tenantProfiles.findFirst({
		where: eq(tenantProfiles.id, tenant.id),
		with: TENANT_DETAIL_WITH
	});

	return json(fullTenant ? toTenantSummaryDto(fullTenant) : null);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json().catch(() => ({}));
		const hasRoomId = typeof body?.roomId === 'string' && body.roomId.trim() !== '';

		if (!hasRoomId) {
			if (!locals.actor) {
				return authorizationErrorToResponse(unauthenticatedError());
			}
			const actorResult = requireLandlordActor(locals.actor);
			if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);

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

		if (isTenancyDualWriteEnabled()) {
			if (!locals.actor) {
				return authorizationErrorToResponse(unauthenticatedError());
			}
			const actorResult = requireLandlordActor(locals.actor);
			if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);

			return await checkInWithTenancyService(body, actorResult.value, locals.requestId);
		}

		return await legacyCheckIn(body, locals);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const actor = actorResult.actor;

		const body = await request.json();
		const tenantId = typeof body?.id === 'string' ? body.id.trim() : '';
		const { idNumber, idFrontImage, idBackImage, vehicleImage, checkInImage } = body;

		if (!tenantId) {
			return json({ error: 'Missing tenantId (ManagedTenant.id)' }, { status: 400 });
		}

		const managedTenant = isLandlordActor(actor)
			? await findManagedTenantForLandlord(db, actor, tenantId)
			: isTenantActor(actor)
				? await findManagedTenantForTenant(db, actor, tenantId)
				: null;

		if (!managedTenant) {
			return forbidden();
		}

		const legacyProfileId = managedTenant.legacyTenantProfileId;
		if (!legacyProfileId) {
			return json({ error: 'Hồ sơ legacy chưa được liên kết' }, { status: 422 });
		}

		const updateData: Record<string, unknown> = {};
		if (idNumber !== undefined) updateData.idNumber = idNumber;
		if (idFrontImage !== undefined) updateData.idFrontImage = idFrontImage;
		if (idBackImage !== undefined) updateData.idBackImage = idBackImage;
		if (vehicleImage !== undefined) updateData.vehicleImage = vehicleImage;
		if (checkInImage !== undefined) updateData.checkInImage = checkInImage;

		if (Object.keys(updateData).length > 0) {
			await db.transaction(async (tx) => {
				const updated = await tx
					.update(tenantProfiles)
					.set(updateData)
					.where(eq(tenantProfiles.id, legacyProfileId))
					.returning({ id: tenantProfiles.id });
				if (!updated[0]) {
					throw new Error('Không tìm thấy hồ sơ người thuê');
				}

				await appendAudit(tx, auditActorFromUserActor(actor), {
					scope: 'LANDLORD',
					action: 'TENANCY.UPDATED',
					resourceType: 'ManagedTenant',
					resourceId: managedTenant.id,
					landlordId: managedTenant.landlordId,
					requestId: locals.requestId,
					metadata: { fields: Object.keys(updateData) }
				});
			});
		}

		const detail = await findManagedTenantDetailForActor(db, actor, tenantId);
		return json(detail);
	} catch (error) {
		const scoped = tenantScopeErrorToResponse(error);
		if (scoped) return scoped;
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
