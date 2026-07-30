import { and, eq, isNull } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { managedTenants, properties, rooms, tenancies } from '$lib/server/db/schema';
import type { TenantActor } from '$lib/server/authorization/actor';
import { operationsForbidden, operationsValidation } from './errors.js';

export type TenancyScope = {
	managedTenantId: string;
	tenancyId: string;
	landlordId: string;
	propertyId: string;
	roomId: string;
	tenantProfileId: string | null;
	propertyName: string;
	roomNumber: string;
	status: string;
};

export type ActiveTenancyScope = TenancyScope;

type TenancyDb = Pick<typeof AppDb, 'select'>;

const tenancySelect = {
	managedTenantId: tenancies.managedTenantId,
	tenancyId: tenancies.id,
	landlordId: tenancies.landlordId,
	propertyId: tenancies.propertyId,
	roomId: tenancies.roomId,
	tenantProfileId: managedTenants.legacyTenantProfileId,
	propertyName: properties.shortName,
	roomNumber: rooms.roomNumber,
	status: tenancies.status
};

function mapTenancyRow(row: {
	managedTenantId: string | null;
	tenancyId: string;
	landlordId: string;
	propertyId: string;
	roomId: string;
	tenantProfileId: string | null;
	propertyName: string;
	roomNumber: string;
	status: string;
}): TenancyScope {
	if (!row.managedTenantId) {
		throw operationsForbidden('Bạn không có lần thuê được phép truy cập');
	}
	return {
		managedTenantId: row.managedTenantId,
		tenancyId: row.tenancyId,
		landlordId: row.landlordId,
		propertyId: row.propertyId,
		roomId: row.roomId,
		tenantProfileId: row.tenantProfileId,
		propertyName: row.propertyName,
		roomNumber: row.roomNumber,
		status: row.status
	};
}

function claimedTenancyQuery(database: TenancyDb, actor: TenantActor) {
	return database
		.select(tenancySelect)
		.from(tenancies)
		.innerJoin(
			managedTenants,
			and(
				eq(tenancies.managedTenantId, managedTenants.id),
				eq(managedTenants.claimedByUserId, actor.userId),
				isNull(managedTenants.claimAccessSuspendedAt)
			)
		)
		.innerJoin(rooms, eq(tenancies.roomId, rooms.id))
		.innerJoin(properties, eq(tenancies.propertyId, properties.id));
}

/**
 * Every tenancy the tenant actor may read (claimed ManagedTenants, including ended history).
 */
export async function listClaimedTenancyScopesForTenant(
	database: TenancyDb,
	actor: TenantActor
): Promise<TenancyScope[]> {
	const rows = await claimedTenancyQuery(database, actor);
	return rows.map(mapTenancyRow);
}

/**
 * Resolve the tenant actor's single ACTIVE claimed tenancy for operational mutations.
 * Fail closed when checkout ended the tenancy or claim is suspended.
 */
export async function requireActiveTenancyForTenant(
	database: TenancyDb,
	actor: TenantActor,
	target: { roomId?: string; tenancyId?: string } = {}
): Promise<ActiveTenancyScope> {
	return resolveTenancyForTenantMutation(database, actor, target);
}

/**
 * Resolve ACTIVE tenancy for tenant mutations by explicit tenancyId or roomId.
 * Ambiguous multi-active for the same room → 422.
 */
export async function resolveTenancyForTenantMutation(
	database: TenancyDb,
	actor: TenantActor,
	target: { roomId?: string; tenancyId?: string }
): Promise<ActiveTenancyScope> {
	const tenancyId = typeof target.tenancyId === 'string' ? target.tenancyId.trim() : '';
	const roomId = typeof target.roomId === 'string' ? target.roomId.trim() : '';

	if (tenancyId) {
		const rows = await claimedTenancyQuery(database, actor).where(
			and(eq(tenancies.id, tenancyId), eq(tenancies.status, 'ACTIVE'))
		);
		const row = rows[0];
		if (!row) {
			throw operationsForbidden('Bạn không có lần thuê đang hiệu lực cho tenancy này');
		}
		if (roomId && row.roomId !== roomId) {
			throw operationsValidation('roomId không khớp tenancy đang hiệu lực');
		}
		return mapTenancyRow(row);
	}

	if (!roomId) {
		const activeRows = await claimedTenancyQuery(database, actor).where(
			eq(tenancies.status, 'ACTIVE')
		);
		if (activeRows.length > 1) {
			throw operationsValidation(
				'Cần chỉ rõ tenancyId hoặc roomId khi có nhiều lần thuê đang hiệu lực'
			);
		}
		const row = activeRows[0];
		if (!row) {
			throw operationsForbidden('Bạn không có lần thuê đang hiệu lực');
		}
		return mapTenancyRow(row);
	}

	const activeForRoom = await claimedTenancyQuery(database, actor).where(
		and(eq(tenancies.roomId, roomId), eq(tenancies.status, 'ACTIVE'))
	);
	if (activeForRoom.length > 1) {
		throw operationsValidation('Nhiều lần thuê ACTIVE cho cùng phòng — cần tenancyId rõ ràng');
	}
	const row = activeForRoom[0];
	if (!row) {
		throw operationsForbidden('Bạn không thuê phòng này');
	}
	return mapTenancyRow(row);
}
