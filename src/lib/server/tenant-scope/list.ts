import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { managedTenants, rooms, tenancies, tenantProfiles, users } from '$lib/server/db/schema';
import type { LandlordActor, StaffActor, TenantActor } from '$lib/server/authorization/actor';
import { staffHasPermission } from '$lib/server/authorization/staff-scope';
import { forbiddenError } from '$lib/server/authorization/errors';
import {
	findManagedTenantForLandlord,
	findManagedTenantForStaff,
	findManagedTenantForTenant,
	ScopedResourceNotFoundError
} from '$lib/server/authorization/scoped-queries';
import type { OperationalUserActor } from '$lib/server/authorization/policies';
import {
	toActiveTenancySummaryDto,
	toManagedTenantDetailForLandlordDto,
	toManagedTenantDetailForStaffDto,
	toManagedTenantDetailForTenantDto,
	toTenantSelfDto,
	toTenantSummaryForLandlordDto,
	toTenantSummaryForStaffDto,
	type ActiveTenancySummaryDto,
	type ManagedTenantDetailForLandlordDto,
	type ManagedTenantDetailForStaffDto,
	type ManagedTenantDetailForTenantDto,
	type TenantSelfDto,
	type TenantSummaryForLandlordDto,
	type TenantSummaryForStaffDto
} from '$lib/server/dto/managed-tenant-directory';
import { isLandlordActor, isStaffActor, isTenantActor } from '$lib/server/property-scope/actor';

export type TenantScopeDb = Pick<typeof AppDb, 'query' | 'select'>;

type ActiveTenancyRow = {
	tenancyId: string;
	managedTenantId: string;
	propertyId: string;
	roomId: string;
	roomNumber: string;
	roomCode: string | null;
	startDate: string;
};

function assignedPropertyIds(actor: StaffActor): string[] {
	return actor.propertyIds.length > 0 ? actor.propertyIds : ['__none__'];
}

function landlordManagedTenantWhere(actor: LandlordActor): SQL {
	return and(eq(managedTenants.landlordId, actor.landlordId), eq(managedTenants.status, 'ACTIVE'))!;
}

async function loadActiveTenancyRows(
	database: TenantScopeDb,
	filter: SQL
): Promise<ActiveTenancyRow[]> {
	const rows = await database
		.select({
			tenancyId: tenancies.id,
			managedTenantId: tenancies.managedTenantId,
			propertyId: tenancies.propertyId,
			roomId: tenancies.roomId,
			roomNumber: rooms.roomNumber,
			roomCode: rooms.roomCode,
			startDate: tenancies.startDate
		})
		.from(tenancies)
		.innerJoin(rooms, eq(tenancies.roomId, rooms.id))
		.where(and(eq(tenancies.status, 'ACTIVE'), filter));

	return rows.filter((row): row is ActiveTenancyRow => row.managedTenantId !== null);
}

function activeTenancyByManagedTenantId(
	rows: ActiveTenancyRow[]
): Map<string, ActiveTenancySummaryDto> {
	const map = new Map<string, ActiveTenancySummaryDto>();
	for (const row of rows) {
		if (!map.has(row.managedTenantId)) {
			map.set(row.managedTenantId, toActiveTenancySummaryDto(row));
		}
	}
	return map;
}

async function listLandlordManagedTenants(
	database: TenantScopeDb,
	actor: LandlordActor
): Promise<TenantSummaryForLandlordDto[]> {
	const tenants = await database.query.managedTenants.findMany({
		where: landlordManagedTenantWhere(actor),
		columns: {
			id: true,
			displayName: true,
			emailSnapshot: true,
			phoneSnapshot: true,
			claimedByUserId: true,
			createdAt: true
		}
	});

	const activeRows = await loadActiveTenancyRows(
		database,
		eq(tenancies.landlordId, actor.landlordId)
	);
	const activeByTenant = activeTenancyByManagedTenantId(activeRows);

	return tenants
		.map((row) =>
			toTenantSummaryForLandlordDto({
				...row,
				activeTenancy: activeByTenant.get(row.id) ?? null
			})
		)
		.sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi'));
}

async function listStaffManagedTenants(
	database: TenantScopeDb,
	actor: StaffActor
): Promise<TenantSummaryForStaffDto[]> {
	if (!staffHasPermission(actor, 'VIEW_TENANTS')) {
		throw forbiddenError();
	}

	const rows = await database
		.select({
			id: managedTenants.id,
			displayName: managedTenants.displayName,
			phoneSnapshot: managedTenants.phoneSnapshot
		})
		.from(managedTenants)
		.innerJoin(
			tenancies,
			and(
				eq(tenancies.managedTenantId, managedTenants.id),
				eq(tenancies.status, 'ACTIVE'),
				inArray(tenancies.propertyId, assignedPropertyIds(actor))
			)
		)
		.where(
			and(eq(managedTenants.landlordId, actor.landlordId), eq(managedTenants.status, 'ACTIVE'))
		);

	const deduped = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		deduped.set(row.id, row);
	}

	const activeRows = await loadActiveTenancyRows(
		database,
		and(
			eq(tenancies.landlordId, actor.landlordId),
			inArray(tenancies.propertyId, assignedPropertyIds(actor))
		)!
	);
	const activeByTenant = activeTenancyByManagedTenantId(activeRows);

	return [...deduped.values()]
		.map((row) =>
			toTenantSummaryForStaffDto({
				...row,
				activeTenancy: activeByTenant.get(row.id) ?? null
			})
		)
		.sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi'));
}

async function listTenantSelf(database: TenantScopeDb, actor: TenantActor): Promise<TenantSelfDto> {
	const user = await database.query.users.findFirst({
		where: eq(users.id, actor.userId),
		columns: { id: true, name: true, email: true, phone: true }
	});
	if (!user) {
		throw new ScopedResourceNotFoundError();
	}

	const claimed = await database.query.managedTenants.findMany({
		where: and(
			eq(managedTenants.claimedByUserId, actor.userId),
			isNull(managedTenants.claimAccessSuspendedAt),
			eq(managedTenants.status, 'ACTIVE')
		),
		columns: { id: true, displayName: true, landlordId: true }
	});

	const activeRows =
		claimed.length === 0
			? []
			: await loadActiveTenancyRows(
					database,
					inArray(
						tenancies.managedTenantId,
						claimed.map((row) => row.id)
					)
				);

	const activeByTenant = new Map<string, ActiveTenancySummaryDto[]>();
	for (const row of activeRows) {
		const list = activeByTenant.get(row.managedTenantId) ?? [];
		list.push(toActiveTenancySummaryDto(row));
		activeByTenant.set(row.managedTenantId, list);
	}

	return toTenantSelfDto({
		user,
		managedTenants: claimed.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			landlordId: row.landlordId,
			activeTenancies: activeByTenant.get(row.id) ?? []
		}))
	});
}

export async function listManagedTenantsForActor(
	database: TenantScopeDb,
	actor: OperationalUserActor
): Promise<TenantSummaryForLandlordDto[] | TenantSummaryForStaffDto[] | TenantSelfDto> {
	if (isLandlordActor(actor)) {
		return listLandlordManagedTenants(database, actor);
	}
	if (isStaffActor(actor)) {
		return listStaffManagedTenants(database, actor);
	}
	if (isTenantActor(actor)) {
		return listTenantSelf(database, actor);
	}
	throw new ScopedResourceNotFoundError();
}

async function loadActiveTenanciesForManagedTenant(
	database: TenantScopeDb,
	managedTenantId: string,
	propertyFilter?: string[]
): Promise<ActiveTenancySummaryDto[]> {
	const propertyClause =
		propertyFilter && propertyFilter.length > 0
			? inArray(tenancies.propertyId, propertyFilter)
			: undefined;

	const rows = await loadActiveTenancyRows(
		database,
		and(eq(tenancies.managedTenantId, managedTenantId), propertyClause)!
	);
	return rows.map(toActiveTenancySummaryDto);
}

async function loadLegacyProfile(managedTenantId: string, database: TenantScopeDb) {
	const managed = await database.query.managedTenants.findFirst({
		where: eq(managedTenants.id, managedTenantId),
		columns: { legacyTenantProfileId: true }
	});
	if (!managed?.legacyTenantProfileId) return null;

	return database.query.tenantProfiles.findFirst({
		where: eq(tenantProfiles.id, managed.legacyTenantProfileId),
		columns: {
			idNumber: true,
			idFrontImage: true,
			idBackImage: true,
			vehicleImage: true,
			checkInImage: true
		}
	});
}

export async function findManagedTenantDetailForActor(
	database: TenantScopeDb,
	actor: OperationalUserActor,
	managedTenantId: string
): Promise<
	| ManagedTenantDetailForLandlordDto
	| ManagedTenantDetailForStaffDto
	| ManagedTenantDetailForTenantDto
> {
	if (isLandlordActor(actor)) {
		const row = await findManagedTenantForLandlord(database, actor, managedTenantId);
		const activeTenancy = (await loadActiveTenanciesForManagedTenant(database, row.id))[0] ?? null;
		const summary = toTenantSummaryForLandlordDto({
			id: row.id,
			displayName: row.displayName,
			emailSnapshot: row.emailSnapshot,
			phoneSnapshot: row.phoneSnapshot,
			claimedByUserId: row.claimedByUserId,
			createdAt: row.createdAt,
			activeTenancy
		});
		return toManagedTenantDetailForLandlordDto(summary, row.legacyTenantProfileId);
	}

	if (isStaffActor(actor)) {
		const row = await findManagedTenantForStaff(database, actor, managedTenantId);
		const activeTenancy =
			(
				await loadActiveTenanciesForManagedTenant(database, row.id, assignedPropertyIds(actor))
			)[0] ?? null;
		return toManagedTenantDetailForStaffDto(
			toTenantSummaryForStaffDto({
				id: row.id,
				displayName: row.displayName,
				phoneSnapshot: row.phoneSnapshot,
				activeTenancy
			})
		);
	}

	if (isTenantActor(actor)) {
		const row = await findManagedTenantForTenant(database, actor, managedTenantId);
		const activeTenancies = await loadActiveTenanciesForManagedTenant(database, row.id);
		const profile = await loadLegacyProfile(row.id, database);
		return toManagedTenantDetailForTenantDto({
			id: row.id,
			displayName: row.displayName,
			landlordId: row.landlordId,
			activeTenancies,
			profile: profile
				? {
						idNumber: profile.idNumber,
						idFrontImage: profile.idFrontImage,
						idBackImage: profile.idBackImage,
						vehicleImage: profile.vehicleImage,
						checkInImage: profile.checkInImage
					}
				: null
		});
	}

	throw new ScopedResourceNotFoundError();
}
