import { and, eq, isNull } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { managedTenants, tenancies } from '$lib/server/db/schema';
import type { TenantActor } from '$lib/server/authorization/actor';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';

export type TenantActiveTenancy = {
	tenancyId: string;
	managedTenantId: string;
	landlordId: string;
	propertyId: string;
	roomId: string;
};

export type PropertyScopeDb = Pick<typeof AppDb, 'select'>;

/** Active tenancies claimed by the tenant actor — authority from actor.userId only. */
export async function loadTenantActiveTenancies(
	database: PropertyScopeDb,
	actor: TenantActor
): Promise<TenantActiveTenancy[]> {
	const rows = await database
		.select({
			tenancyId: tenancies.id,
			managedTenantId: tenancies.managedTenantId,
			landlordId: tenancies.landlordId,
			propertyId: tenancies.propertyId,
			roomId: tenancies.roomId
		})
		.from(tenancies)
		.innerJoin(managedTenants, eq(tenancies.managedTenantId, managedTenants.id))
		.where(
			and(
				eq(managedTenants.claimedByUserId, actor.userId),
				isNull(managedTenants.claimAccessSuspendedAt),
				eq(tenancies.status, 'ACTIVE')
			)
		);

	return rows
		.filter((row): row is TenantActiveTenancy => row.managedTenantId !== null)
		.map((row) => ({
			tenancyId: row.tenancyId,
			managedTenantId: row.managedTenantId,
			landlordId: row.landlordId,
			propertyId: row.propertyId,
			roomId: row.roomId
		}));
}

export async function requireTenantActiveTenancy(
	database: PropertyScopeDb,
	actor: TenantActor
): Promise<TenantActiveTenancy> {
	const active = await loadTenantActiveTenancies(database, actor);
	if (active.length === 0) {
		throw new ScopedResourceNotFoundError();
	}
	return active[0];
}

export function tenantRoomIds(active: TenantActiveTenancy[]): string[] {
	return active.length > 0 ? active.map((row) => row.roomId) : ['__none__'];
}

export function tenantPropertyIds(active: TenantActiveTenancy[]): string[] {
	return active.length > 0 ? active.map((row) => row.propertyId) : ['__none__'];
}

export function tenantLandlordIds(active: TenantActiveTenancy[]): string[] {
	const ids = [...new Set(active.map((row) => row.landlordId))];
	return ids.length > 0 ? ids : ['__none__'];
}

export function assertTenantPropertyInScope(
	active: TenantActiveTenancy[],
	propertyId: string
): void {
	if (!active.some((row) => row.propertyId === propertyId)) {
		throw new ScopedResourceNotFoundError();
	}
}

export function assertTenantRoomInScope(active: TenantActiveTenancy[], roomId: string): void {
	if (!active.some((row) => row.roomId === roomId)) {
		throw new ScopedResourceNotFoundError();
	}
}

export async function loadTenantActiveTenanciesForRooms(
	database: PropertyScopeDb,
	actor: TenantActor,
	roomIds: string[]
): Promise<TenantActiveTenancy[]> {
	if (roomIds.length === 0) return [];
	const active = await loadTenantActiveTenancies(database, actor);
	return active.filter((row) => roomIds.includes(row.roomId));
}
