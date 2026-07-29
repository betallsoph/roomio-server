import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import {
	contracts,
	invoices,
	maintenanceRequests,
	managedTenants,
	meterReadings,
	paymentAccounts,
	properties,
	roomAssets,
	rooms,
	tenancies
} from '$lib/server/db/schema';
import type {
	ActorContext,
	LandlordActor,
	StaffActor,
	StaffPermission,
	TenantActor
} from './actor.js';
import { forbiddenError } from './errors.js';
import { staffHasPermission, staffHasProperty } from './staff-scope.js';

/**
 * AUTH-008 — typed scoped query helpers.
 * Authority comes from ActorContext only; never from body/query landlordId.
 * Foreign ID and missing row both surface ScopedResourceNotFoundError (§12.2).
 */

export class ScopedResourceNotFoundError extends Error {
	readonly status = 404 as const;

	constructor(message = 'Không tìm thấy') {
		super(message);
		this.name = 'ScopedResourceNotFoundError';
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export type TenantHistoryScope = {
	managedTenantId: string;
	tenancyId: string;
};

export type StaffCapabilityCheck = StaffPermission | ((actor: StaffActor) => boolean);

export type ScopedQueryDb = Pick<typeof AppDb, 'query' | 'select'>;

function throwScopedNotFound(): never {
	throw new ScopedResourceNotFoundError();
}

function staffHasCapabilityCheck(actor: StaffActor, check: StaffCapabilityCheck): boolean {
	return typeof check === 'function' ? check(actor) : staffHasPermission(actor, check);
}

function assertStaffAccess(
	actor: StaffActor,
	propertyId: string,
	check: StaffCapabilityCheck
): void {
	if (!staffHasCapabilityCheck(actor, check)) {
		throw forbiddenError();
	}
	if (!staffHasProperty(actor, propertyId)) {
		throw forbiddenError();
	}
}

async function assertTenantHistoryClaim(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope
): Promise<void> {
	const managedTenant = await database.query.managedTenants.findFirst({
		where: and(
			eq(managedTenants.id, scope.managedTenantId),
			eq(managedTenants.claimedByUserId, actor.userId)
		),
		columns: { id: true }
	});
	if (!managedTenant) {
		throwScopedNotFound();
	}

	const tenancy = await database.query.tenancies.findFirst({
		where: and(
			eq(tenancies.id, scope.tenancyId),
			eq(tenancies.managedTenantId, scope.managedTenantId)
		),
		columns: { id: true }
	});
	if (!tenancy) {
		throwScopedNotFound();
	}
}

/** SQL predicate for landlord-owned properties (single-table list/detail). */
export function landlordPropertyWhere(landlordId: string): SQL {
	return eq(properties.landlordId, landlordId);
}

/** SQL predicate after joining rooms → properties. */
export function landlordRoomWhere(landlordId: string): SQL {
	return eq(properties.landlordId, landlordId);
}

export function landlordManagedTenantWhere(landlordId: string): SQL {
	return eq(managedTenants.landlordId, landlordId);
}

export function landlordTenancyWhere(landlordId: string): SQL {
	return eq(tenancies.landlordId, landlordId);
}

export function landlordPaymentAccountWhere(landlordId: string): SQL {
	return eq(paymentAccounts.landlordId, landlordId);
}

export function staffAssignedPropertiesWhere(actor: StaffActor): SQL {
	return inArray(properties.id, actor.propertyIds.length > 0 ? actor.propertyIds : ['__none__']);
}

// --- Property ---

export async function findPropertyForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	propertyId: string
) {
	const row = await database.query.properties.findFirst({
		where: and(eq(properties.id, propertyId), landlordPropertyWhere(actor.landlordId))
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

export async function findPropertyForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	propertyId: string,
	capability: StaffCapabilityCheck
) {
	assertStaffAccess(actor, propertyId, capability);
	const row = await database.query.properties.findFirst({
		where: and(
			eq(properties.id, propertyId),
			eq(properties.landlordId, actor.landlordId),
			staffAssignedPropertiesWhere(actor)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Room ---

export async function findRoomForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	roomId: string
) {
	const rows = await database
		.select({ room: rooms })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(rooms.id, roomId), landlordRoomWhere(actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].room;
}

export async function findRoomForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	roomId: string,
	capability: StaffCapabilityCheck
) {
	const rows = await database
		.select({ room: rooms, propertyId: properties.id })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(rooms.id, roomId), eq(properties.landlordId, actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	assertStaffAccess(actor, rows[0].propertyId, capability);
	return rows[0].room;
}

// --- Managed tenant ---

export async function findManagedTenantForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	managedTenantId: string
) {
	const row = await database.query.managedTenants.findFirst({
		where: and(eq(managedTenants.id, managedTenantId), landlordManagedTenantWhere(actor.landlordId))
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

export async function findManagedTenantForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	managedTenantId: string,
	capability: StaffCapabilityCheck = 'VIEW_TENANTS'
) {
	if (!staffHasCapabilityCheck(actor, capability)) {
		throw forbiddenError();
	}
	if (actor.propertyIds.length === 0) {
		throw forbiddenError();
	}

	const rows = await database
		.select({ managedTenant: managedTenants })
		.from(managedTenants)
		.innerJoin(
			tenancies,
			and(
				eq(tenancies.managedTenantId, managedTenants.id),
				eq(tenancies.status, 'ACTIVE'),
				inArray(tenancies.propertyId, actor.propertyIds)
			)
		)
		.where(
			and(eq(managedTenants.id, managedTenantId), eq(managedTenants.landlordId, actor.landlordId))
		)
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].managedTenant;
}

// --- Tenancy ---

export async function findTenancyForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	tenancyId: string
) {
	const row = await database.query.tenancies.findFirst({
		where: and(eq(tenancies.id, tenancyId), landlordTenancyWhere(actor.landlordId))
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

export async function findTenancyForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	tenancyId: string,
	capability: StaffCapabilityCheck = 'VIEW_TENANTS'
) {
	if (!staffHasCapabilityCheck(actor, capability)) {
		throw forbiddenError();
	}
	if (actor.propertyIds.length === 0) {
		throw forbiddenError();
	}

	const row = await database.query.tenancies.findFirst({
		where: and(
			eq(tenancies.id, tenancyId),
			eq(tenancies.landlordId, actor.landlordId),
			inArray(tenancies.propertyId, actor.propertyIds)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Invoice ---

export async function findInvoiceForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	invoiceId: string
) {
	const rows = await database
		.select({ invoice: invoices })
		.from(invoices)
		.innerJoin(rooms, eq(invoices.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(invoices.id, invoiceId), landlordRoomWhere(actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].invoice;
}

export async function findInvoiceForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	invoiceId: string,
	capability: StaffCapabilityCheck = 'VIEW_TENANTS'
) {
	const rows = await database
		.select({ invoice: invoices, propertyId: properties.id })
		.from(invoices)
		.innerJoin(rooms, eq(invoices.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(invoices.id, invoiceId), eq(properties.landlordId, actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	assertStaffAccess(actor, rows[0].propertyId, capability);
	return rows[0].invoice;
}

export async function findInvoiceForTenantHistory(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	invoiceId: string
) {
	await assertTenantHistoryClaim(database, actor, scope);

	const row = await database.query.invoices.findFirst({
		where: and(
			eq(invoices.id, invoiceId),
			eq(invoices.managedTenantId, scope.managedTenantId),
			eq(invoices.tenancyId, scope.tenancyId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Contract ---

export async function findContractForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	contractId: string
) {
	const rows = await database
		.select({ contract: contracts })
		.from(contracts)
		.innerJoin(rooms, eq(contracts.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(contracts.id, contractId), landlordRoomWhere(actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].contract;
}

export async function findContractForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	contractId: string,
	capability: StaffCapabilityCheck = 'VIEW_TENANTS'
) {
	const rows = await database
		.select({ contract: contracts, propertyId: properties.id })
		.from(contracts)
		.innerJoin(rooms, eq(contracts.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(contracts.id, contractId), eq(properties.landlordId, actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	assertStaffAccess(actor, rows[0].propertyId, capability);
	return rows[0].contract;
}

export async function findContractForTenantHistory(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	contractId: string
) {
	await assertTenantHistoryClaim(database, actor, scope);

	const row = await database.query.contracts.findFirst({
		where: and(
			eq(contracts.id, contractId),
			eq(contracts.managedTenantId, scope.managedTenantId),
			eq(contracts.tenancyId, scope.tenancyId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Meter reading ---

export async function findMeterReadingForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	meterReadingId: string
) {
	const rows = await database
		.select({ meterReading: meterReadings })
		.from(meterReadings)
		.innerJoin(rooms, eq(meterReadings.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(meterReadings.id, meterReadingId), landlordRoomWhere(actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].meterReading;
}

export async function findMeterReadingForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	meterReadingId: string,
	capability: StaffCapabilityCheck = 'MANAGE_METERS'
) {
	const rows = await database
		.select({ meterReading: meterReadings, propertyId: properties.id })
		.from(meterReadings)
		.innerJoin(rooms, eq(meterReadings.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(meterReadings.id, meterReadingId), eq(properties.landlordId, actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	assertStaffAccess(actor, rows[0].propertyId, capability);
	return rows[0].meterReading;
}

export async function findMeterReadingForTenantHistory(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	meterReadingId: string
) {
	await assertTenantHistoryClaim(database, actor, scope);

	const row = await database.query.meterReadings.findFirst({
		where: and(
			eq(meterReadings.id, meterReadingId),
			eq(meterReadings.managedTenantId, scope.managedTenantId),
			eq(meterReadings.tenancyId, scope.tenancyId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Maintenance request ---

export async function findMaintenanceRequestForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	requestId: string
) {
	const rows = await database
		.select({ request: maintenanceRequests })
		.from(maintenanceRequests)
		.innerJoin(tenancies, eq(maintenanceRequests.tenancyId, tenancies.id))
		.where(and(eq(maintenanceRequests.id, requestId), landlordTenancyWhere(actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].request;
}

export async function findMaintenanceRequestForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	requestId: string,
	capability: StaffCapabilityCheck = 'MANAGE_REQUESTS'
) {
	const rows = await database
		.select({ request: maintenanceRequests, propertyId: tenancies.propertyId })
		.from(maintenanceRequests)
		.innerJoin(tenancies, eq(maintenanceRequests.tenancyId, tenancies.id))
		.where(and(eq(maintenanceRequests.id, requestId), eq(tenancies.landlordId, actor.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	assertStaffAccess(actor, rows[0].propertyId, capability);
	return rows[0].request;
}

export async function findMaintenanceRequestForTenantHistory(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	requestId: string
) {
	await assertTenantHistoryClaim(database, actor, scope);

	const row = await database.query.maintenanceRequests.findFirst({
		where: and(
			eq(maintenanceRequests.id, requestId),
			eq(maintenanceRequests.managedTenantId, scope.managedTenantId),
			eq(maintenanceRequests.tenancyId, scope.tenancyId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Payment account ---

export async function findPaymentAccountForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	paymentAccountId: string
) {
	const row = await database.query.paymentAccounts.findFirst({
		where: and(
			eq(paymentAccounts.id, paymentAccountId),
			landlordPaymentAccountWhere(actor.landlordId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Child mutation: room asset bound to room + landlord ---

export async function findRoomAssetForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	input: { roomId: string; assetId: string }
) {
	const rows = await database
		.select({ asset: roomAssets })
		.from(roomAssets)
		.innerJoin(rooms, eq(roomAssets.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				eq(roomAssets.id, input.assetId),
				eq(roomAssets.roomId, input.roomId),
				landlordRoomWhere(actor.landlordId)
			)
		)
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].asset;
}

export async function findRoomAssetForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	input: { roomId: string; assetId: string },
	capability: StaffCapabilityCheck = 'VIEW_ROOMS'
) {
	const rows = await database
		.select({ asset: roomAssets, propertyId: properties.id })
		.from(roomAssets)
		.innerJoin(rooms, eq(roomAssets.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				eq(roomAssets.id, input.assetId),
				eq(roomAssets.roomId, input.roomId),
				eq(properties.landlordId, actor.landlordId)
			)
		)
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	assertStaffAccess(actor, rows[0].propertyId, capability);
	return rows[0].asset;
}

/** Reject machine/super-admin actors at endpoint boundary before calling scoped helpers. */
export function isUserActor(
	actor: ActorContext
): actor is Exclude<ActorContext, { kind: 'MACHINE' }> {
	return actor.kind === 'USER';
}
