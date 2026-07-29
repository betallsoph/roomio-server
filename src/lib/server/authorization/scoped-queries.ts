import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import type { db as AppDb } from '$lib/server/db';
import {
	contracts,
	invoices,
	maintenanceRequests,
	managedTenants,
	messages,
	meterReadings,
	paymentAccounts,
	properties,
	roomAssets,
	rooms,
	services,
	tenancies,
	tenantProfiles
} from '$lib/server/db/schema';
import type {
	LandlordActor,
	StaffActor,
	TenantActor
} from './actor.js';
import {
	type StaffCapabilityCheck,
	type StaffScopedCapability,
	staffHasPropertyReadCapability,
	staffScopedCapabilityForAction,
	staffServiceReadCapability
} from './capabilities.js';
import { forbiddenError } from './errors.js';
import { isOperationalUserActor } from './policies.js';
import { staffHasPermission, staffHasProperty } from './staff-scope.js';

export { isOperationalUserActor };
export type { StaffCapabilityCheck, StaffScopedCapability } from './capabilities.js';

/**
 * AUTH-008 — typed scoped query helpers.
 * Authority comes from ActorContext only; never from body/query landlordId.
 * Foreign ID and missing row both surface ScopedResourceNotFoundError (§12.2).
 * Staff outside property assignment → 404; missing capability on in-scope resource → 403.
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

export type ConversationScope = TenantHistoryScope;

export type ResolvedConversation = {
	conversationId: string;
	landlordId: string;
	managedTenantId: string;
	tenancyId: string;
	tenantProfileId: string | null;
};

export type ScopedQueryDb = Pick<typeof AppDb, 'query' | 'select'>;

/**
 * Query-only mirror of planned TenantFile (DATA ticket). Replace with schema import when merged.
 */
const tenantFiles = pgTable('TenantFile', {
	id: text('id').primaryKey(),
	landlordId: text('landlordId').notNull(),
	managedTenantId: text('managedTenantId').notNull(),
	tenancyId: text('tenancyId'),
	visibility: text('visibility').notNull()
});

function throwScopedNotFound(): never {
	throw new ScopedResourceNotFoundError();
}

function assertStaffPermission(actor: StaffActor, permission: StaffCapabilityCheck): void {
	if (!staffHasPermission(actor, permission)) {
		throw forbiddenError();
	}
}

function assertStaffScopedCapability(actor: StaffActor, capability: StaffScopedCapability): void {
	switch (capability) {
		case 'PROPERTY_READ':
			if (!staffHasPropertyReadCapability(actor.permissions)) {
				throw forbiddenError();
			}
			break;
		case 'PROPERTY_ASSIGNMENT_ONLY':
			break;
		default:
			assertStaffPermission(actor, capability);
	}
}

function assertStaffPropertyInScope(actor: StaffActor, propertyId: string): void {
	if (!staffHasProperty(actor, propertyId)) {
		throwScopedNotFound();
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
			eq(managedTenants.claimedByUserId, actor.userId),
			isNull(managedTenants.claimAccessSuspendedAt)
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

async function resolveTenantProfileId(
	database: ScopedQueryDb,
	managedTenant: { legacyTenantProfileId: string | null; claimedByUserId: string | null }
): Promise<string | null> {
	if (managedTenant.legacyTenantProfileId) {
		return managedTenant.legacyTenantProfileId;
	}
	if (!managedTenant.claimedByUserId) {
		return null;
	}
	const profile = await database.query.tenantProfiles.findFirst({
		where: eq(tenantProfiles.userId, managedTenant.claimedByUserId),
		columns: { id: true }
	});
	return profile?.id ?? null;
}

function legacyConversationId(landlordId: string, tenantProfileId: string): string {
	return `${landlordId}_${tenantProfileId}`;
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

export function landlordServiceWhere(landlordId: string): SQL {
	return eq(services.landlordId, landlordId);
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
	capability: StaffScopedCapability = staffScopedCapabilityForAction('property', 'detail') ??
		'PROPERTY_READ'
) {
	const row = await database.query.properties.findFirst({
		where: and(
			eq(properties.id, propertyId),
			eq(properties.landlordId, actor.landlordId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	assertStaffPropertyInScope(actor, propertyId);
	assertStaffScopedCapability(actor, capability);
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
	capability: StaffScopedCapability = staffScopedCapabilityForAction('room', 'detail') ??
		'PROPERTY_READ'
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
	assertStaffPropertyInScope(actor, rows[0].propertyId);
	assertStaffScopedCapability(actor, capability);
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
	const rows = await database
		.select({ managedTenant: managedTenants })
		.from(managedTenants)
		.innerJoin(
			tenancies,
			and(
				eq(tenancies.managedTenantId, managedTenants.id),
				eq(tenancies.status, 'ACTIVE'),
				inArray(tenancies.propertyId, actor.propertyIds.length > 0 ? actor.propertyIds : ['__none__'])
			)
		)
		.where(
			and(eq(managedTenants.id, managedTenantId), eq(managedTenants.landlordId, actor.landlordId))
		)
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	assertStaffScopedCapability(actor, capability);
	return rows[0].managedTenant;
}

export async function findManagedTenantForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	managedTenantId: string
) {
	const row = await database.query.managedTenants.findFirst({
		where: and(
			eq(managedTenants.id, managedTenantId),
			eq(managedTenants.claimedByUserId, actor.userId),
			isNull(managedTenants.claimAccessSuspendedAt)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
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
	const row = await database.query.tenancies.findFirst({
		where: and(
			eq(tenancies.id, tenancyId),
			eq(tenancies.landlordId, actor.landlordId),
			eq(tenancies.status, 'ACTIVE'),
			inArray(tenancies.propertyId, actor.propertyIds.length > 0 ? actor.propertyIds : ['__none__'])
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	assertStaffScopedCapability(actor, capability);
	return row;
}

export async function findTenancyForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	options: { requireActive?: boolean } = { requireActive: true }
) {
	await assertTenantHistoryClaim(database, actor, scope);

	const row = await database.query.tenancies.findFirst({
		where:
			options.requireActive !== false
				? and(
						eq(tenancies.id, scope.tenancyId),
						eq(tenancies.managedTenantId, scope.managedTenantId),
						eq(tenancies.status, 'ACTIVE')
					)
				: and(
						eq(tenancies.id, scope.tenancyId),
						eq(tenancies.managedTenantId, scope.managedTenantId)
					)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Service catalog ---

export async function findServiceForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	serviceId: string
) {
	const row = await database.query.services.findFirst({
		where: and(eq(services.id, serviceId), landlordServiceWhere(actor.landlordId))
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

export async function findServiceForStaff(
	database: ScopedQueryDb,
	actor: StaffActor,
	serviceId: string,
	capability: StaffScopedCapability = staffScopedCapabilityForAction('service', 'detail') ??
		'PROPERTY_ASSIGNMENT_ONLY'
) {
	if (actor.propertyIds.length === 0) {
		throwScopedNotFound();
	}

	const row = await database.query.services.findFirst({
		where: and(eq(services.id, serviceId), eq(services.landlordId, actor.landlordId))
	});
	if (!row) {
		throwScopedNotFound();
	}

	assertStaffScopedCapability(actor, capability);
	if (!staffServiceReadCapability(actor.permissions)) {
		throw forbiddenError();
	}
	return row;
}

export async function findServiceForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	serviceId: string
) {
	const tenancy = await findTenancyForTenant(database, actor, scope);

	const row = await database.query.services.findFirst({
		where: and(eq(services.id, serviceId), eq(services.landlordId, tenancy.landlordId))
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Invoice (landlord/tenant history only; staff finance blocked in MVP) ---

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

// --- Contract (landlord/tenant history only; staff finance blocked in MVP) ---

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
	assertStaffPropertyInScope(actor, rows[0].propertyId);
	assertStaffScopedCapability(actor, capability);
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
		.where(
			and(eq(maintenanceRequests.id, requestId), eq(tenancies.landlordId, actor.landlordId))
		)
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	assertStaffPropertyInScope(actor, rows[0].propertyId);
	assertStaffScopedCapability(actor, capability);
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

export async function findPaymentAccountForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	paymentAccountId: string
) {
	const tenancy = await findTenancyForTenant(database, actor, scope);

	const row = await database.query.paymentAccounts.findFirst({
		where: and(
			eq(paymentAccounts.id, paymentAccountId),
			eq(paymentAccounts.landlordId, tenancy.landlordId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Conversation / message ---

export async function findConversationForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	scope: ConversationScope
): Promise<ResolvedConversation> {
	const rows = await database
		.select({ tenancy: tenancies, managedTenant: managedTenants })
		.from(tenancies)
		.innerJoin(managedTenants, eq(tenancies.managedTenantId, managedTenants.id))
		.where(
			and(
				eq(tenancies.id, scope.tenancyId),
				eq(managedTenants.id, scope.managedTenantId),
				eq(tenancies.landlordId, actor.landlordId),
				eq(managedTenants.landlordId, actor.landlordId)
			)
		)
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}

	const tenantProfileId = await resolveTenantProfileId(database, rows[0].managedTenant);
	if (!tenantProfileId) {
		throwScopedNotFound();
	}

	return {
		conversationId: legacyConversationId(actor.landlordId, tenantProfileId),
		landlordId: actor.landlordId,
		managedTenantId: scope.managedTenantId,
		tenancyId: scope.tenancyId,
		tenantProfileId
	};
}

export async function findConversationForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: ConversationScope
): Promise<ResolvedConversation> {
	await assertTenantHistoryClaim(database, actor, scope);

	const rows = await database
		.select({ tenancy: tenancies, managedTenant: managedTenants })
		.from(tenancies)
		.innerJoin(managedTenants, eq(tenancies.managedTenantId, managedTenants.id))
		.where(
			and(
				eq(tenancies.id, scope.tenancyId),
				eq(managedTenants.id, scope.managedTenantId),
				eq(managedTenants.claimedByUserId, actor.userId)
			)
		)
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}

	const tenantProfileId = await resolveTenantProfileId(database, rows[0].managedTenant);
	if (!tenantProfileId) {
		throwScopedNotFound();
	}

	return {
		conversationId: legacyConversationId(rows[0].tenancy.landlordId, tenantProfileId),
		landlordId: rows[0].tenancy.landlordId,
		managedTenantId: scope.managedTenantId,
		tenancyId: scope.tenancyId,
		tenantProfileId
	};
}

export async function findMessageForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	scope: ConversationScope,
	messageId: string
) {
	const conversation = await findConversationForLandlord(database, actor, scope);

	const row = await database.query.messages.findFirst({
		where: and(
			eq(messages.id, messageId),
			eq(messages.conversationId, conversation.conversationId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

export async function findMessageForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: ConversationScope,
	messageId: string
) {
	const conversation = await findConversationForTenant(database, actor, scope);

	const row = await database.query.messages.findFirst({
		where: and(
			eq(messages.id, messageId),
			eq(messages.conversationId, conversation.conversationId)
		)
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

// --- Tenant file ---

export async function findFileForLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	fileId: string,
	scope: { managedTenantId: string; tenancyId?: string }
) {
	const filePredicates = [
		eq(tenantFiles.id, fileId),
		eq(tenantFiles.landlordId, actor.landlordId),
		eq(tenantFiles.managedTenantId, scope.managedTenantId),
		eq(managedTenants.landlordId, actor.landlordId)
	];
	if (scope.tenancyId) {
		filePredicates.push(eq(tenantFiles.tenancyId, scope.tenancyId));
	}

	const rows = await database
		.select({ file: tenantFiles })
		.from(tenantFiles)
		.innerJoin(managedTenants, eq(tenantFiles.managedTenantId, managedTenants.id))
		.where(and(...filePredicates))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].file;
}

export async function findFileForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	fileId: string
) {
	await assertTenantHistoryClaim(database, actor, scope);

	const tenantFilePredicates = [
		eq(tenantFiles.id, fileId),
		eq(tenantFiles.managedTenantId, scope.managedTenantId),
		eq(tenantFiles.tenancyId, scope.tenancyId)
	];

	const rows = await database
		.select({ file: tenantFiles })
		.from(tenantFiles)
		.where(and(...tenantFilePredicates))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	if (rows[0].file.visibility === 'LANDLORD_ONLY') {
		throwScopedNotFound();
	}
	return rows[0].file;
}

// --- Tenant property/room snapshot via tenancy ---

export async function findPropertyForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	propertyId: string
) {
	const tenancy = await findTenancyForTenant(database, actor, scope);
	if (tenancy.propertyId !== propertyId) {
		throwScopedNotFound();
	}

	const row = await database.query.properties.findFirst({
		where: and(eq(properties.id, propertyId), eq(properties.landlordId, tenancy.landlordId))
	});
	if (!row) {
		throwScopedNotFound();
	}
	return row;
}

export async function findRoomForTenant(
	database: ScopedQueryDb,
	actor: TenantActor,
	scope: TenantHistoryScope,
	roomId: string
) {
	const tenancy = await findTenancyForTenant(database, actor, scope);
	if (tenancy.roomId !== roomId) {
		throwScopedNotFound();
	}

	const rows = await database
		.select({ room: rooms })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(rooms.id, roomId), eq(properties.landlordId, tenancy.landlordId)))
		.limit(1);
	if (!rows[0]) {
		throwScopedNotFound();
	}
	return rows[0].room;
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
	assertStaffPropertyInScope(actor, rows[0].propertyId);
	assertStaffScopedCapability(actor, capability);
	return rows[0].asset;
}
