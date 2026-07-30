import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { maintenanceRequests, managedTenants, tenancies } from '$lib/server/db/schema';
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
	operationsConflict,
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

async function landlordOwnsRequestRow(
	database: OperationsDb,
	actor: LandlordActor,
	requestId: string
) {
	const row = await database.query.maintenanceRequests.findFirst({
		where: eq(maintenanceRequests.id, requestId)
	});
	if (!row?.landlordId || row.landlordId !== actor.landlordId) {
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
	if (!row.landlordId || row.landlordId !== actor.landlordId) {
		throw operationsNotFound();
	}
	if (!row.propertyId || !propertyIds.includes(row.propertyId)) {
		throw operationsNotFound();
	}
	return row;
}

export async function listMaintenanceRequestsForActor(
	database: OperationsDb,
	actor: LandlordActor | StaffActor | TenantActor
): Promise<MaintenanceRequestListRow[]> {
	const columns = {
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
	} as const;

	const withRelations = {
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
	} as const;

	if (actor.role === 'TENANT') {
		const rows = await database
			.select({ id: maintenanceRequests.id })
			.from(maintenanceRequests)
			.innerJoin(
				tenancies,
				and(
					eq(maintenanceRequests.tenancyId, tenancies.id),
					eq(maintenanceRequests.managedTenantId, tenancies.managedTenantId)
				)
			)
			.innerJoin(
				managedTenants,
				and(
					eq(tenancies.managedTenantId, managedTenants.id),
					eq(managedTenants.claimedByUserId, actor.userId),
					isNull(managedTenants.claimAccessSuspendedAt)
				)
			);

		if (rows.length === 0) {
			return [];
		}

		return database.query.maintenanceRequests.findMany({
			where: inArray(
				maintenanceRequests.id,
				rows.map((row) => row.id)
			),
			columns,
			with: withRelations,
			orderBy: desc(maintenanceRequests.createdAt)
		});
	}

	const conditions: SQL[] = [];

	if (actor.role === 'LANDLORD') {
		conditions.push(eq(maintenanceRequests.landlordId, actor.landlordId));
	} else {
		if (!staffHasPermission(actor, 'MANAGE_REQUESTS')) {
			throw forbiddenError();
		}
		const propertyIds = assignedPropertyIds(actor);
		conditions.push(
			eq(maintenanceRequests.landlordId, actor.landlordId),
			inArray(maintenanceRequests.propertyId, propertyIds)
		);
	}

	return database.query.maintenanceRequests.findMany({
		where: and(...conditions),
		columns,
		with: withRelations,
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
	tenancyId?: string | null;
};

export async function createMaintenanceRequestForActor(
	database: OperationsDb,
	actor: UserActor,
	input: CreateMaintenanceRequestInput
) {
	const { category, title, description, imageUrl, priority, tenancyId } = input;
	if (!category || !title || !description) {
		throw operationsValidation('Missing required maintenance request fields');
	}

	if (actor.role === 'TENANT') {
		const tenancy = await requireActiveTenancyForTenant(database, actor, {
			tenancyId: tenancyId ?? undefined
		});
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

	if (actor.role === 'STAFF' && existing.assignedToId !== actor.staffId) {
		throw operationsForbidden('Bạn chỉ được cập nhật sự cố được giao cho mình');
	}

	const updateData: Record<string, unknown> = {};
	const expectedStatus = existing.status;

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

	const whereConditions = [eq(maintenanceRequests.id, input.id)];

	if (actor.role === 'STAFF') {
		whereConditions.push(eq(maintenanceRequests.assignedToId, actor.staffId));
		if (existing.propertyId) {
			whereConditions.push(eq(maintenanceRequests.propertyId, existing.propertyId));
		}
		whereConditions.push(eq(maintenanceRequests.status, expectedStatus));
	} else if (existing.landlordId) {
		whereConditions.push(eq(maintenanceRequests.landlordId, existing.landlordId));
	}

	const updated = await database
		.update(maintenanceRequests)
		.set(updateData)
		.where(and(...whereConditions))
		.returning();

	if (!updated[0]) {
		if (actor.role === 'STAFF' && input.status !== undefined) {
			throw operationsConflict('Trạng thái sự cố đã thay đổi hoặc không còn được giao cho bạn');
		}
		throw operationsNotFound();
	}

	return updated[0];
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
