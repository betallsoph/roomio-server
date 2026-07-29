import { and, desc, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { maintenanceRequests, properties, rooms } from '$lib/server/db/schema';
import type {
	LandlordActor,
	StaffActor,
	TenantActor,
	UserActor
} from '$lib/server/authorization/actor';
import { forbiddenError } from '$lib/server/authorization/errors';
import { staffHasPermission } from '$lib/server/authorization/staff-scope';
import { requireActiveTenancyForTenant } from './active-tenancy.js';
import { assertStaffAssigneeForProperty } from './assignee.js';
import {
	isOperationsError,
	operationsForbidden,
	operationsNotFound,
	operationsValidation
} from './errors.js';

type OperationsDb = typeof AppDb;

export const STAFF_MAINTENANCE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
	pending: ['in_progress'],
	in_progress: ['completed']
};

const PUBLIC_USER_COLUMNS = {
	id: true,
	name: true,
	phone: true
} as const;

export type MaintenanceRequestListRow = {
	id: string;
	tenantId: string;
	roomNumber: string;
	buildingName: string;
	category: string;
	title: string;
	description: string;
	imageUrl: string | null;
	status: string;
	priority: string;
	createdAt: Date;
	updatedAt: Date;
	response: string | null;
	assignedToId: string | null;
	managedTenantId: string | null;
	tenancyId: string | null;
	landlordId: string | null;
	propertyId: string | null;
	roomId: string | null;
	tenant: {
		id: string;
		user: { name: string; phone: string } | null;
	} | null;
	assignedTo: {
		id: string;
		user: { name: string; phone: string } | null;
	} | null;
};

function assignedPropertyIds(actor: StaffActor): string[] {
	return actor.propertyIds.length > 0 ? actor.propertyIds : ['__none__'];
}

function legacyLandlordTenantIdsSubquery(database: OperationsDb, landlordId: string) {
	return database
		.select({ id: rooms.tenantId })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(properties.landlordId, landlordId), isNotNull(rooms.tenantId)));
}

async function landlordOwnsRequestRow(
	database: OperationsDb,
	actor: LandlordActor,
	requestId: string
) {
	const row = await database.query.maintenanceRequests.findFirst({
		where: eq(maintenanceRequests.id, requestId)
	});
	if (!row) {
		throw operationsNotFound();
	}
	if (row.landlordId) {
		if (row.landlordId !== actor.landlordId) {
			throw operationsNotFound();
		}
		return row;
	}

	const legacy = await database
		.select({ id: maintenanceRequests.id })
		.from(maintenanceRequests)
		.innerJoin(rooms, eq(maintenanceRequests.tenantId, rooms.tenantId))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(maintenanceRequests.id, requestId), eq(properties.landlordId, actor.landlordId)))
		.limit(1);
	if (!legacy[0]) {
		throw operationsNotFound();
	}
	return row;
}

async function staffCanAccessRequestRow(
	database: OperationsDb,
	actor: StaffActor,
	requestId: string
) {
	if (!staffHasPermission(actor, 'MANAGE_REQUESTS')) {
		throw forbiddenError();
	}

	const row = await database.query.maintenanceRequests.findFirst({
		where: eq(maintenanceRequests.id, requestId)
	});
	if (!row) {
		throw operationsNotFound();
	}

	const propertyIds = assignedPropertyIds(actor);
	if (row.landlordId && row.landlordId !== actor.landlordId) {
		throw operationsNotFound();
	}
	if (row.propertyId) {
		if (!propertyIds.includes(row.propertyId)) {
			throw operationsNotFound();
		}
		return row;
	}

	const legacy = await database
		.select({ id: maintenanceRequests.id })
		.from(maintenanceRequests)
		.innerJoin(rooms, eq(maintenanceRequests.tenantId, rooms.tenantId))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				eq(maintenanceRequests.id, requestId),
				inArray(rooms.propertyId, propertyIds),
				eq(properties.landlordId, actor.landlordId)
			)
		)
		.limit(1);
	if (!legacy[0]) {
		throw operationsNotFound();
	}
	return row;
}

export async function listMaintenanceRequestsForActor(
	database: OperationsDb,
	actor: LandlordActor | StaffActor | TenantActor
): Promise<MaintenanceRequestListRow[]> {
	const conditions: SQL[] = [];

	if (actor.role === 'LANDLORD') {
		conditions.push(
			or(
				eq(maintenanceRequests.landlordId, actor.landlordId),
				and(
					isNull(maintenanceRequests.landlordId),
					inArray(
						maintenanceRequests.tenantId,
						legacyLandlordTenantIdsSubquery(database, actor.landlordId)
					)
				)
			)!
		);
	} else if (actor.role === 'STAFF') {
		if (!staffHasPermission(actor, 'MANAGE_REQUESTS')) {
			throw forbiddenError();
		}
		const propertyIds = assignedPropertyIds(actor);
		conditions.push(
			or(
				and(
					eq(maintenanceRequests.landlordId, actor.landlordId),
					inArray(maintenanceRequests.propertyId, propertyIds)
				),
				and(
					isNull(maintenanceRequests.propertyId),
					inArray(
						maintenanceRequests.tenantId,
						database
							.select({ id: rooms.tenantId })
							.from(rooms)
							.where(inArray(rooms.propertyId, propertyIds))
					)
				)
			)!
		);
	} else {
		const tenancy = await requireActiveTenancyForTenant(database, actor);
		conditions.push(
			or(
				and(
					eq(maintenanceRequests.tenancyId, tenancy.tenancyId),
					eq(maintenanceRequests.managedTenantId, tenancy.managedTenantId)
				),
				and(
					isNull(maintenanceRequests.tenancyId),
					eq(maintenanceRequests.tenantId, actor.tenantProfileId)
				)
			)!
		);
	}

	return database.query.maintenanceRequests.findMany({
		where: and(...conditions),
		columns: {
			id: true,
			tenantId: true,
			roomNumber: true,
			buildingName: true,
			category: true,
			title: true,
			description: true,
			imageUrl: true,
			status: true,
			priority: true,
			createdAt: true,
			updatedAt: true,
			response: true,
			assignedToId: true,
			managedTenantId: true,
			tenancyId: true,
			landlordId: true,
			propertyId: true,
			roomId: true
		},
		with: {
			tenant: {
				columns: { id: true },
				with: {
					user: {
						columns: PUBLIC_USER_COLUMNS
					}
				}
			},
			assignedTo: {
				columns: { id: true },
				with: {
					user: {
						columns: PUBLIC_USER_COLUMNS
					}
				}
			}
		},
		orderBy: desc(maintenanceRequests.createdAt)
	});
}

export type CreateMaintenanceRequestInput = {
	roomNumber: string;
	buildingName: string;
	category: string;
	title: string;
	description: string;
	imageUrl?: string | null;
	priority?: string | null;
};

export async function createMaintenanceRequestForActor(
	database: OperationsDb,
	actor: UserActor,
	input: CreateMaintenanceRequestInput
) {
	const { category, title, description, imageUrl, priority } = input;
	if (!category || !title || !description) {
		throw operationsValidation('Missing required maintenance request fields');
	}

	if (actor.role === 'TENANT') {
		const tenancy = await requireActiveTenancyForTenant(database, actor);
		const tenantProfileId = tenancy.tenantProfileId ?? actor.tenantProfileId;
		if (!tenantProfileId) {
			throw operationsForbidden('Bạn không có hồ sơ người thuê để gửi yêu cầu');
		}

		return (
			await database
				.insert(maintenanceRequests)
				.values({
					tenantId: tenantProfileId,
					roomNumber: tenancy.roomNumber,
					buildingName: tenancy.propertyName,
					category,
					title,
					description,
					imageUrl: imageUrl ?? null,
					priority: priority || 'normal',
					status: 'pending',
					landlordId: tenancy.landlordId,
					propertyId: tenancy.propertyId,
					roomId: tenancy.roomId,
					managedTenantId: tenancy.managedTenantId,
					tenancyId: tenancy.tenancyId
				})
				.returning()
		)[0];
	}

	throw forbiddenError();
}

export type UpdateMaintenanceRequestInput = {
	id: string;
	status?: string;
	response?: string | null;
	assignedToId?: string | null;
};

function assertStaffStatusTransition(current: string, next: string): void {
	const allowed = STAFF_MAINTENANCE_STATUS_TRANSITIONS[current] ?? [];
	if (!allowed.includes(next)) {
		throw operationsForbidden('Nhân viên không được chuyển trạng thái này');
	}
}

export async function updateMaintenanceRequestForActor(
	database: OperationsDb,
	actor: LandlordActor | StaffActor,
	input: UpdateMaintenanceRequestInput
) {
	if (!input.id) {
		throw operationsValidation('Missing maintenance request ID');
	}

	const existing =
		actor.role === 'LANDLORD'
			? await landlordOwnsRequestRow(database, actor, input.id)
			: await staffCanAccessRequestRow(database, actor, input.id);

	if (actor.role === 'STAFF') {
		if (existing.assignedToId !== actor.staffId) {
			throw operationsForbidden('Bạn chỉ được cập nhật sự cố được giao cho mình');
		}
	}

	const updateData: Record<string, unknown> = {};
	if (input.status !== undefined) {
		if (actor.role === 'STAFF') {
			assertStaffStatusTransition(existing.status, input.status);
		}
		updateData.status = input.status;
	}
	if (input.response !== undefined) {
		updateData.response = input.response;
	}
	if (input.assignedToId !== undefined) {
		if (actor.role !== 'LANDLORD') {
			throw operationsForbidden('Chỉ chủ trọ được đổi người phụ trách');
		}
		const propertyId = existing.propertyId;
		if (!propertyId) {
			throw operationsNotFound();
		}
		if (input.assignedToId) {
			await assertStaffAssigneeForProperty(database, actor, input.assignedToId, propertyId);
		}
		updateData.assignedToId = input.assignedToId;
	}

	if (Object.keys(updateData).length === 0) {
		throw operationsValidation('No fields to update');
	}

	return (
		await database
			.update(maintenanceRequests)
			.set(updateData)
			.where(eq(maintenanceRequests.id, input.id))
			.returning()
	)[0];
}

export async function deleteMaintenanceRequestForActor(
	database: OperationsDb,
	actor: LandlordActor,
	requestId: string
) {
	await landlordOwnsRequestRow(database, actor, requestId);
	await database.delete(maintenanceRequests).where(eq(maintenanceRequests.id, requestId));
}

export { isOperationsError };
