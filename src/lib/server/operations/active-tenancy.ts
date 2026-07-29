import { and, eq, isNull } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { managedTenants, properties, rooms, tenancies } from '$lib/server/db/schema';
import type { TenantActor } from '$lib/server/authorization/actor';
import { operationsForbidden } from './errors.js';

export type ActiveTenancyScope = {
	managedTenantId: string;
	tenancyId: string;
	landlordId: string;
	propertyId: string;
	roomId: string;
	tenantProfileId: string | null;
	propertyName: string;
	roomNumber: string;
};

type TenancyDb = Pick<typeof AppDb, 'select'>;

/**
 * Resolve the tenant actor's single ACTIVE claimed tenancy for operational mutations.
 * Fail closed when checkout ended the tenancy or claim is suspended.
 */
export async function requireActiveTenancyForTenant(
	database: TenancyDb,
	actor: TenantActor
): Promise<ActiveTenancyScope> {
	const rows = await database
		.select({
			managedTenantId: tenancies.managedTenantId,
			tenancyId: tenancies.id,
			landlordId: tenancies.landlordId,
			propertyId: tenancies.propertyId,
			roomId: tenancies.roomId,
			tenantProfileId: managedTenants.legacyTenantProfileId,
			propertyName: properties.shortName,
			roomNumber: rooms.roomNumber
		})
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
		.innerJoin(properties, eq(tenancies.propertyId, properties.id))
		.where(eq(tenancies.status, 'ACTIVE'))
		.limit(1);

	const row = rows[0];
	if (!row?.managedTenantId) {
		throw operationsForbidden('Bạn không có lần thuê đang hiệu lực');
	}

	return {
		managedTenantId: row.managedTenantId,
		tenancyId: row.tenancyId,
		landlordId: row.landlordId,
		propertyId: row.propertyId,
		roomId: row.roomId,
		tenantProfileId: row.tenantProfileId,
		propertyName: row.propertyName,
		roomNumber: row.roomNumber
	};
}
