import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import {
	blocks,
	meterReadings,
	properties,
	roomServiceConfigs,
	rooms,
	services
} from '$lib/server/db/schema';
import type { LandlordActor, StaffActor, TenantActor } from '$lib/server/authorization/actor';
import {
	staffHasPropertyReadCapability,
	staffServiceReadCapability
} from '$lib/server/authorization/capabilities';
import { forbiddenError } from '$lib/server/authorization/errors';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';
import type { OperationalUserActor } from '$lib/server/authorization/policies';
import { isLandlordActor, isStaffActor, isTenantActor } from './actor.js';
import {
	assertTenantPropertyInScope,
	assertTenantRoomInScope,
	loadTenantActiveTenancies,
	tenantPropertyIds,
	tenantRoomIds
} from './tenant-tenancies.js';
import {
	BLOCK_COLUMNS,
	PROPERTY_SUMMARY_COLUMNS,
	ROOM_ASSET_COLUMNS,
	ROOM_COLUMNS,
	ROOM_SERVICE_CONFIG_COLUMNS,
	SERVICE_COLUMNS,
	ROOM_DETAIL_WITH
} from '$lib/server/dto/rooms';

export type PropertyScopeDb = Pick<typeof AppDb, 'query' | 'select'>;

export type RoomListFilters = {
	propertyId?: string | null;
	blockId?: string | null;
	status?: string | null;
};

const ROOM_SUMMARY_COLUMNS = {
	id: true,
	roomNumber: true,
	status: true,
	roomType: true,
	monthlyRent: true
} as const;

const PROPERTY_LIST_WITH = {
	blocks: true,
	rooms: { columns: ROOM_SUMMARY_COLUMNS }
} as const;

const TENANT_ROOM_WITH = {
	block: { columns: BLOCK_COLUMNS },
	property: { columns: PROPERTY_SUMMARY_COLUMNS },
	paymentAccount: { columns: ROOM_DETAIL_WITH.paymentAccount.columns },
	assets: { columns: ROOM_ASSET_COLUMNS },
	services: {
		columns: ROOM_SERVICE_CONFIG_COLUMNS,
		with: { service: { columns: SERVICE_COLUMNS } }
	}
} as const;

const STAFF_ROOM_WITH = {
	block: ROOM_DETAIL_WITH.block,
	property: ROOM_DETAIL_WITH.property,
	assets: ROOM_DETAIL_WITH.assets,
	services: ROOM_DETAIL_WITH.services
} as const;

function assignedPropertyIds(actor: StaffActor): string[] {
	return actor.propertyIds.length > 0 ? actor.propertyIds : ['__none__'];
}

function assertStaffPropertyRead(actor: StaffActor): void {
	if (!staffHasPropertyReadCapability(actor.permissions)) {
		throw forbiddenError();
	}
}

function assertStaffServiceRead(actor: StaffActor): void {
	if (!staffServiceReadCapability(actor.permissions)) {
		throw forbiddenError();
	}
}

function landlordPropertyWhere(actor: LandlordActor): SQL {
	return eq(properties.landlordId, actor.landlordId);
}

function staffPropertyWhere(actor: StaffActor): SQL {
	assertStaffPropertyRead(actor);
	return and(
		eq(properties.landlordId, actor.landlordId),
		inArray(properties.id, assignedPropertyIds(actor))
	)!;
}

function dedupeServices<T extends { id: string }>(rows: T[]): T[] {
	const seen = new Set<string>();
	return rows.filter((row) => {
		if (seen.has(row.id)) return false;
		seen.add(row.id);
		return true;
	});
}

export async function listPropertiesForActor(
	database: PropertyScopeDb,
	actor: OperationalUserActor
) {
	if (isLandlordActor(actor)) {
		return database.query.properties.findMany({
			where: landlordPropertyWhere(actor),
			with: PROPERTY_LIST_WITH,
			orderBy: asc(properties.name)
		});
	}

	if (isStaffActor(actor)) {
		return database.query.properties.findMany({
			where: staffPropertyWhere(actor),
			with: PROPERTY_LIST_WITH,
			orderBy: asc(properties.name)
		});
	}

	if (isTenantActor(actor)) {
		const active = await loadTenantActiveTenancies(database, actor);
		if (active.length === 0) return [];
		return database.query.properties.findMany({
			where: and(
				inArray(properties.id, tenantPropertyIds(active)),
				inArray(properties.landlordId, [...new Set(active.map((row) => row.landlordId))])
			),
			with: {
				blocks: true,
				rooms: {
					columns: ROOM_SUMMARY_COLUMNS,
					where: inArray(rooms.id, tenantRoomIds(active))
				}
			},
			orderBy: asc(properties.name)
		});
	}

	throw forbiddenError();
}

export async function listRoomsForActor(
	database: PropertyScopeDb,
	actor: OperationalUserActor,
	filters: RoomListFilters
) {
	if (isTenantActor(actor)) {
		const active = await loadTenantActiveTenancies(database, actor);
		if (active.length === 0) return [];
		if (filters.propertyId) {
			assertTenantPropertyInScope(active, filters.propertyId);
		}
		const conditions: SQL[] = [inArray(rooms.id, tenantRoomIds(active))];
		if (filters.propertyId) conditions.push(eq(rooms.propertyId, filters.propertyId));
		if (filters.blockId && filters.blockId !== 'all') {
			conditions.push(eq(rooms.blockId, filters.blockId));
		}
		if (filters.status) conditions.push(eq(rooms.status, filters.status));

		return database.query.rooms.findMany({
			where: and(...conditions),
			columns: ROOM_COLUMNS,
			with: TENANT_ROOM_WITH,
			orderBy: asc(rooms.roomNumber)
		});
	}

	if (isLandlordActor(actor)) {
		const conditions: SQL[] = [
			inArray(
				rooms.propertyId,
				database.select({ id: properties.id }).from(properties).where(landlordPropertyWhere(actor))
			)
		];
		if (filters.propertyId) {
			const owned = await database.query.properties.findFirst({
				where: and(eq(properties.id, filters.propertyId), landlordPropertyWhere(actor)),
				columns: { id: true }
			});
			if (!owned) throw new ScopedResourceNotFoundError();
			conditions.push(eq(rooms.propertyId, filters.propertyId));
		}
		if (filters.blockId && filters.blockId !== 'all') {
			conditions.push(eq(rooms.blockId, filters.blockId));
		}
		if (filters.status) conditions.push(eq(rooms.status, filters.status));

		return database.query.rooms.findMany({
			where: and(...conditions),
			with: {
				...ROOM_DETAIL_WITH,
				meterReadings: {
					...ROOM_DETAIL_WITH.meterReadings,
					orderBy: desc(meterReadings.month)
				}
			},
			orderBy: asc(rooms.roomNumber)
		});
	}

	if (isStaffActor(actor)) {
		assertStaffPropertyRead(actor);
		const conditions: SQL[] = [
			inArray(
				rooms.propertyId,
				database.select({ id: properties.id }).from(properties).where(staffPropertyWhere(actor))
			)
		];
		if (filters.propertyId) {
			if (!assignedPropertyIds(actor).includes(filters.propertyId)) {
				throw new ScopedResourceNotFoundError();
			}
			conditions.push(eq(rooms.propertyId, filters.propertyId));
		}
		if (filters.blockId && filters.blockId !== 'all') {
			conditions.push(eq(rooms.blockId, filters.blockId));
		}
		if (filters.status) conditions.push(eq(rooms.status, filters.status));

		return database.query.rooms.findMany({
			where: and(...conditions),
			with: STAFF_ROOM_WITH,
			orderBy: asc(rooms.roomNumber)
		});
	}

	throw forbiddenError();
}

export async function listServicesForActor(database: PropertyScopeDb, actor: OperationalUserActor) {
	if (isLandlordActor(actor)) {
		return database
			.select()
			.from(services)
			.where(eq(services.landlordId, actor.landlordId))
			.orderBy(asc(services.name));
	}

	if (isStaffActor(actor)) {
		assertStaffServiceRead(actor);
		const rows = await database
			.select({ service: services })
			.from(services)
			.innerJoin(roomServiceConfigs, eq(roomServiceConfigs.serviceId, services.id))
			.innerJoin(rooms, eq(roomServiceConfigs.roomId, rooms.id))
			.innerJoin(properties, eq(rooms.propertyId, properties.id))
			.where(
				and(
					eq(services.landlordId, actor.landlordId),
					inArray(properties.id, assignedPropertyIds(actor))
				)
			)
			.orderBy(asc(services.name));
		return dedupeServices(rows.map((row) => row.service));
	}

	if (isTenantActor(actor)) {
		const active = await loadTenantActiveTenancies(database, actor);
		if (active.length === 0) return [];
		const rows = await database
			.select({ service: services })
			.from(services)
			.innerJoin(roomServiceConfigs, eq(roomServiceConfigs.serviceId, services.id))
			.innerJoin(rooms, eq(roomServiceConfigs.roomId, rooms.id))
			.where(
				and(
					inArray(rooms.id, tenantRoomIds(active)),
					inArray(services.landlordId, [...new Set(active.map((row) => row.landlordId))])
				)
			)
			.orderBy(asc(services.name));
		return dedupeServices(rows.map((row) => row.service));
	}

	throw forbiddenError();
}

export async function findPropertyDetailForActor(
	database: PropertyScopeDb,
	actor: OperationalUserActor,
	propertyId: string
) {
	if (isLandlordActor(actor)) {
		const row = await database.query.properties.findFirst({
			where: and(eq(properties.id, propertyId), landlordPropertyWhere(actor)),
			with: PROPERTY_LIST_WITH
		});
		if (!row) throw new ScopedResourceNotFoundError();
		return row;
	}

	if (isStaffActor(actor)) {
		const row = await database.query.properties.findFirst({
			where: and(eq(properties.id, propertyId), staffPropertyWhere(actor)),
			with: PROPERTY_LIST_WITH
		});
		if (!row) throw new ScopedResourceNotFoundError();
		return row;
	}

	if (isTenantActor(actor)) {
		const active = await loadTenantActiveTenancies(database, actor);
		assertTenantPropertyInScope(active, propertyId);
		const row = await database.query.properties.findFirst({
			where: and(
				eq(properties.id, propertyId),
				inArray(properties.landlordId, [...new Set(active.map((t) => t.landlordId))])
			),
			with: {
				blocks: true,
				rooms: {
					columns: ROOM_SUMMARY_COLUMNS,
					where: inArray(rooms.id, tenantRoomIds(active))
				}
			}
		});
		if (!row) throw new ScopedResourceNotFoundError();
		return row;
	}

	throw forbiddenError();
}

export async function assertBlockBelongsToProperty(
	database: PropertyScopeDb,
	propertyId: string,
	blockId: string
): Promise<void> {
	const block = await database.query.blocks.findFirst({
		where: and(eq(blocks.id, blockId), eq(blocks.propertyId, propertyId)),
		columns: { id: true }
	});
	if (!block) {
		throw new ScopedResourceNotFoundError('Block không thuộc tòa nhà đã chọn');
	}
}

export async function assertTenantRoomAccess(
	database: PropertyScopeDb,
	actor: TenantActor,
	roomId: string
): Promise<void> {
	const active = await loadTenantActiveTenancies(database, actor);
	assertTenantRoomInScope(active, roomId);
}
