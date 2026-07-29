import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import {
	meterReadings,
	properties,
	rooms,
	roomServiceConfigs,
	services
} from '$lib/server/db/schema';
import type {
	LandlordActor,
	StaffActor,
	TenantActor,
	UserActor
} from '$lib/server/authorization/actor';
import {
	findMeterReadingForLandlord,
	findMeterReadingForStaff,
	ScopedResourceNotFoundError
} from '$lib/server/authorization/scoped-queries';
import { forbiddenError } from '$lib/server/authorization/errors';
import { staffHasPermission } from '$lib/server/authorization/staff-scope';
import { requireActiveTenancyForTenant } from './active-tenancy.js';
import {
	isOperationsError,
	operationsConflict,
	operationsForbidden,
	operationsValidation
} from './errors.js';

type OperationsDb = typeof AppDb;

const ANOMALY_THRESHOLD = 0.5;

export type MeterReadingListFilters = {
	status?: string | null;
	month?: string | null;
};

export type MeterReadingListRow = {
	id: string;
	roomId: string;
	serviceId: string;
	month: string;
	prevValue: number;
	submittedValue: number | null;
	currValue: number;
	recordedAt: string;
	photoUrl: string | null;
	ocrParsedValue: number | null;
	status: string;
	submittedBy: string;
	isAnomalous: boolean;
	managedTenantId: string | null;
	tenancyId: string | null;
	roomNumber: string;
	propertyName: string;
	serviceName: string | null;
};

function assignedPropertyIds(actor: StaffActor): string[] {
	return actor.propertyIds.length > 0 ? actor.propertyIds : ['__none__'];
}

function staffMeterScopeWhere(actor: StaffActor): SQL {
	if (!staffHasPermission(actor, 'MANAGE_METERS')) {
		throw forbiddenError();
	}
	return and(
		eq(properties.landlordId, actor.landlordId),
		inArray(properties.id, assignedPropertyIds(actor))
	)!;
}

export async function listMeterReadingsForActor(
	database: OperationsDb,
	actor: LandlordActor | StaffActor | TenantActor,
	filters: MeterReadingListFilters = {}
): Promise<MeterReadingListRow[]> {
	const conditions: SQL[] = [];

	if (actor.role === 'LANDLORD') {
		conditions.push(eq(properties.landlordId, actor.landlordId));
	} else if (actor.role === 'STAFF') {
		conditions.push(staffMeterScopeWhere(actor));
	} else {
		const tenancy = await requireActiveTenancyForTenant(database, actor);
		conditions.push(
			or(
				and(
					eq(meterReadings.tenancyId, tenancy.tenancyId),
					eq(meterReadings.managedTenantId, tenancy.managedTenantId)
				),
				and(
					isNull(meterReadings.tenancyId),
					eq(meterReadings.roomId, tenancy.roomId)
				)
			)!
		);
	}

	if (filters.status) {
		conditions.push(eq(meterReadings.status, filters.status));
	}
	if (filters.month) {
		conditions.push(eq(meterReadings.month, filters.month));
	}

	return database
		.select({
			id: meterReadings.id,
			roomId: meterReadings.roomId,
			serviceId: meterReadings.serviceId,
			month: meterReadings.month,
			prevValue: meterReadings.prevValue,
			submittedValue: meterReadings.submittedValue,
			currValue: meterReadings.currValue,
			recordedAt: meterReadings.recordedAt,
			photoUrl: meterReadings.photoUrl,
			ocrParsedValue: meterReadings.ocrParsedValue,
			status: meterReadings.status,
			submittedBy: meterReadings.submittedBy,
			isAnomalous: meterReadings.isAnomalous,
			managedTenantId: meterReadings.managedTenantId,
			tenancyId: meterReadings.tenancyId,
			roomNumber: rooms.roomNumber,
			propertyName: properties.shortName,
			serviceName: services.name
		})
		.from(meterReadings)
		.innerJoin(rooms, eq(meterReadings.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.leftJoin(services, eq(meterReadings.serviceId, services.id))
		.where(and(...conditions))
		.orderBy(desc(meterReadings.month), desc(meterReadings.recordedAt));
}

export type SubmitMeterReadingInput = {
	roomId: string;
	serviceId: string;
	month: string;
	currValue: unknown;
	photoUrl?: string | null;
	ocrParsedValue?: unknown;
};

async function loadMeteredServiceForRoom(
	database: OperationsDb,
	roomId: string,
	serviceId: string
) {
	const rows = await database
		.select({
			name: services.name,
			type: services.type,
			isActive: services.isActive,
			landlordId: services.landlordId,
			propertyId: rooms.propertyId
		})
		.from(roomServiceConfigs)
		.innerJoin(services, eq(roomServiceConfigs.serviceId, services.id))
		.innerJoin(rooms, eq(roomServiceConfigs.roomId, rooms.id))
		.where(and(eq(roomServiceConfigs.roomId, roomId), eq(roomServiceConfigs.serviceId, serviceId)))
		.limit(1);
	return rows[0] ?? null;
}

export async function submitMeterReadingForActor(
	database: OperationsDb,
	actor: UserActor,
	input: SubmitMeterReadingInput
) {
	const { roomId, serviceId, month, currValue, photoUrl, ocrParsedValue } = input;

	if (!roomId || !serviceId || !month || currValue === undefined || currValue === '') {
		throw operationsValidation('Thiếu thông tin chỉ số');
	}

	let tenancyScope: Awaited<ReturnType<typeof requireActiveTenancyForTenant>> | null = null;

	if (actor.role === 'TENANT') {
		if (typeof photoUrl !== 'string' || !photoUrl.trim()) {
			throw operationsValidation('Khách thuê cần chụp ảnh đồng hồ trước khi gửi');
		}
		tenancyScope = await requireActiveTenancyForTenant(database, actor);
		if (roomId !== tenancyScope.roomId) {
			throw operationsForbidden('Bạn không thuê phòng này');
		}
	} else if (actor.role === 'LANDLORD') {
		const owned = await database
			.select({ id: rooms.id })
			.from(rooms)
			.innerJoin(properties, eq(rooms.propertyId, properties.id))
			.where(and(eq(rooms.id, roomId), eq(properties.landlordId, actor.landlordId)))
			.limit(1);
		if (!owned[0]) {
			throw new ScopedResourceNotFoundError();
		}
	} else {
		throw forbiddenError();
	}

	const serviceConfig = await loadMeteredServiceForRoom(database, roomId, serviceId);
	if (!serviceConfig || !serviceConfig.isActive) {
		throw operationsValidation('Dịch vụ này không còn áp dụng cho phòng');
	}
	if (serviceConfig.type !== 'METERED') {
		throw operationsValidation(
			`${serviceConfig.name} đang tính khoán hàng tháng, không cần gửi chỉ số đồng hồ`
		);
	}
	if (actor.role === 'LANDLORD' && serviceConfig.landlordId !== actor.landlordId) {
		throw new ScopedResourceNotFoundError();
	}

	const history = await database
		.select()
		.from(meterReadings)
		.where(
			and(
				eq(meterReadings.roomId, roomId),
				eq(meterReadings.serviceId, serviceId),
				eq(meterReadings.status, 'approved')
			)
		)
		.orderBy(desc(meterReadings.month))
		.limit(4);

	const latest = history[0];
	const prevValue = latest ? latest.currValue : 0;
	const curr = Number(currValue);
	if (!Number.isFinite(curr)) {
		throw operationsValidation('Chỉ số mới không hợp lệ');
	}
	if (curr < prevValue) {
		throw operationsValidation(`Chỉ số mới (${curr}) không được nhỏ hơn chỉ số cũ (${prevValue})`);
	}

	const usage = curr - prevValue;
	const pastUsages = history
		.slice(0, 3)
		.map((row) => row.currValue - row.prevValue)
		.filter((value) => value > 0);
	const avgUsage =
		pastUsages.length > 0 ? pastUsages.reduce((a, b) => a + b, 0) / pastUsages.length : 0;
	const isAnomalous = avgUsage > 0 && Math.abs(usage - avgUsage) / avgUsage > ANOMALY_THRESHOLD;

	const existing = await database.query.meterReadings.findFirst({
		where: and(
			eq(meterReadings.roomId, roomId),
			eq(meterReadings.serviceId, serviceId),
			eq(meterReadings.month, month)
		)
	});
	if (existing?.status === 'approved') {
		throw operationsConflict('Chỉ số tháng này đã được chủ nhà chốt, không thể gửi lại');
	}

	const parsedOcr =
		ocrParsedValue === undefined || ocrParsedValue === null || ocrParsedValue === ''
			? null
			: Number(ocrParsedValue);
	if (parsedOcr !== null && !Number.isFinite(parsedOcr)) {
		throw operationsValidation('Chỉ số OCR không hợp lệ');
	}

	const values = {
		roomId,
		serviceId,
		month,
		prevValue,
		submittedValue: curr,
		currValue: curr,
		recordedAt: new Date().toISOString().split('T')[0],
		photoUrl: photoUrl || null,
		ocrParsedValue: parsedOcr,
		status: 'pending' as const,
		submittedBy: actor.role === 'TENANT' ? 'TENANT' : 'LANDLORD',
		isAnomalous,
		managedTenantId: tenancyScope?.managedTenantId ?? null,
		tenancyId: tenancyScope?.tenancyId ?? null
	};

	if (existing) {
		return (
			await database
				.update(meterReadings)
				.set(values)
				.where(eq(meterReadings.id, existing.id))
				.returning()
		)[0];
	}

	return (await database.insert(meterReadings).values(values).returning())[0];
}

export type ResolveMeterReadingInput = {
	id: string;
	action: 'approve' | 'reject';
	currValue?: unknown;
};

export async function resolveMeterReadingForActor(
	database: OperationsDb,
	actor: LandlordActor | StaffActor,
	input: ResolveMeterReadingInput
) {
	const reading =
		actor.role === 'LANDLORD'
			? await findMeterReadingForLandlord(database, actor, input.id)
			: await findMeterReadingForStaff(database, actor, input.id);

	if (reading.status !== 'pending') {
		throw operationsConflict('Bản ghi này đã được xử lý');
	}

	const updateData: Record<string, unknown> = {
		status: input.action === 'approve' ? 'approved' : 'rejected'
	};

	if (input.action === 'approve') {
		if (reading.submittedBy === 'TENANT' && !reading.photoUrl) {
			throw operationsValidation('Không thể duyệt chỉ số khách gửi khi chưa có ảnh đồng hồ');
		}
		const approvedValue =
			input.currValue === undefined ? reading.currValue : Number(input.currValue);
		if (!Number.isFinite(approvedValue)) {
			throw operationsValidation('Chỉ số duyệt không hợp lệ');
		}
		if (approvedValue < reading.prevValue) {
			throw operationsValidation(
				`Chỉ số duyệt (${approvedValue}) không được nhỏ hơn chỉ số cũ (${reading.prevValue})`
			);
		}

		const history = await database
			.select()
			.from(meterReadings)
			.where(
				and(
					eq(meterReadings.roomId, reading.roomId),
					eq(meterReadings.serviceId, reading.serviceId),
					eq(meterReadings.status, 'approved')
				)
			)
			.orderBy(desc(meterReadings.month))
			.limit(3);
		const usages = history
			.map((item) => item.currValue - item.prevValue)
			.filter((usage) => usage > 0);
		const average = usages.length
			? usages.reduce((total, usage) => total + usage, 0) / usages.length
			: 0;
		const usage = approvedValue - reading.prevValue;

		updateData.currValue = approvedValue;
		updateData.isAnomalous =
			average > 0 && Math.abs(usage - average) / average > ANOMALY_THRESHOLD;
	}

	return (
		await database
			.update(meterReadings)
			.set(updateData)
			.where(eq(meterReadings.id, input.id))
			.returning()
	)[0];
}

export { isOperationsError };
