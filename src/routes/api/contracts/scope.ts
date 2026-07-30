import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { contracts, managedTenants, properties, rooms } from '$lib/server/db/schema';
import type { LandlordActor, TenantActor } from '$lib/server/authorization/actor';
import {
	findContractForLandlord,
	findPaymentAccountForLandlord,
	ScopedResourceNotFoundError
} from '$lib/server/authorization/scoped-queries';
import { listClaimedTenancyScopesForTenant } from '$lib/server/operations/active-tenancy';

type ContractDb = typeof AppDb;

export type ContractListFilters = {
	tenantProfileId?: string | null;
};

const contractWithRelations = {
	tenant: { with: { user: { columns: { name: true, phone: true } } } },
	paymentAccount: true,
	room: {
		with: {
			property: { columns: { name: true, shortName: true } },
			paymentAccount: true
		}
	}
} as const;

function landlordRoomIdsSubquery(database: ContractDb, landlordId: string) {
	return database
		.select({ id: rooms.id })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(eq(properties.landlordId, landlordId));
}

function tenantSnapshotOrConditions(
	scopes: Array<{ managedTenantId: string; tenancyId: string }>
): SQL | undefined {
	if (scopes.length === 0) {
		return undefined;
	}
	const parts = scopes.map((scope) =>
		and(
			eq(contracts.managedTenantId, scope.managedTenantId),
			eq(contracts.tenancyId, scope.tenancyId)
		)
	);
	return or(...parts)!;
}

export async function listContractsForLandlord(
	database: ContractDb,
	actor: LandlordActor,
	filters: ContractListFilters = {}
) {
	const conditions: SQL[] = [
		inArray(contracts.roomId, landlordRoomIdsSubquery(database, actor.landlordId))
	];

	if (filters.tenantProfileId) {
		const managedTenantIds = database
			.select({ id: managedTenants.id })
			.from(managedTenants)
			.where(
				and(
					eq(managedTenants.landlordId, actor.landlordId),
					eq(managedTenants.legacyTenantProfileId, filters.tenantProfileId)
				)
			);
		conditions.push(
			or(
				inArray(contracts.managedTenantId, managedTenantIds),
				and(isNull(contracts.tenancyId), eq(contracts.tenantId, filters.tenantProfileId))
			)!
		);
	}

	return database.query.contracts.findMany({
		where: and(...conditions),
		with: contractWithRelations,
		orderBy: desc(contracts.createdAt)
	});
}

/** Tenant list uses managedTenantId + tenancyId snapshots only — no current-room fallback. */
export async function listContractsForTenant(database: ContractDb, actor: TenantActor) {
	const scopes = await listClaimedTenancyScopesForTenant(database, actor);
	const snapshotWhere = tenantSnapshotOrConditions(scopes);
	if (!snapshotWhere) {
		return [];
	}

	return database.query.contracts.findMany({
		where: snapshotWhere,
		with: contractWithRelations,
		orderBy: desc(contracts.createdAt)
	});
}

export async function updateContractForLandlord(
	database: ContractDb,
	actor: LandlordActor,
	contractId: string,
	updateData: Record<string, unknown>
) {
	await findContractForLandlord(database, actor, contractId);

	const updated = await database
		.update(contracts)
		.set(updateData)
		.where(eq(contracts.id, contractId))
		.returning();

	if (!updated[0]) {
		throw new ScopedResourceNotFoundError();
	}
	return updated[0];
}

export async function deleteContractForLandlord(
	database: ContractDb,
	actor: LandlordActor,
	contractId: string
) {
	await findContractForLandlord(database, actor, contractId);

	const deleted = await database
		.delete(contracts)
		.where(eq(contracts.id, contractId))
		.returning({ id: contracts.id });

	if (!deleted[0]) {
		throw new ScopedResourceNotFoundError();
	}
}

export async function resolveContractPaymentAccount(
	database: ContractDb,
	actor: LandlordActor,
	paymentAccountId: string | null | undefined
): Promise<string> {
	if (!paymentAccountId) {
		throw new ScopedResourceNotFoundError('Tài khoản nhận tiền không hợp lệ');
	}
	const account = await findPaymentAccountForLandlord(database, actor, paymentAccountId);
	if (!account.isActive) {
		throw new Error('Tài khoản nhận tiền đã tắt');
	}
	return account.id;
}
