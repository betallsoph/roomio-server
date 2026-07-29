import assert from 'node:assert/strict';
import test from 'node:test';
import {
	contracts,
	invoices,
	maintenanceRequests,
	meterReadings,
	roomAssets,
	rooms
} from '$lib/server/db/schema';
import type { LandlordActor, StaffActor, TenantActor } from './actor.js';
import { AuthorizationError } from './errors.js';
import {
	ScopedResourceNotFoundError,
	findContractForLandlord,
	findContractForTenantHistory,
	findInvoiceForLandlord,
	findInvoiceForTenantHistory,
	findManagedTenantForLandlord,
	findMaintenanceRequestForLandlord,
	findMeterReadingForLandlord,
	findPaymentAccountForLandlord,
	findPropertyForLandlord,
	findRoomAssetForLandlord,
	findRoomForLandlord,
	findRoomForStaff,
	findTenancyForLandlord,
	type ScopedQueryDb,
	type TenantHistoryScope
} from './scoped-queries.js';

const LANDLORD_A: LandlordActor = {
	kind: 'USER',
	userId: 'user-a',
	role: 'LANDLORD',
	landlordId: 'landlord-a'
};

const LANDLORD_B: LandlordActor = {
	kind: 'USER',
	userId: 'user-b',
	role: 'LANDLORD',
	landlordId: 'landlord-b'
};

const STAFF_ASSIGNED: StaffActor = {
	kind: 'USER',
	userId: 'staff-user',
	role: 'STAFF',
	staffId: 'staff-1',
	landlordId: 'landlord-a',
	propertyIds: ['property-a1'],
	permissions: ['VIEW_ROOMS']
};

const STAFF_UNASSIGNED: StaffActor = {
	...STAFF_ASSIGNED,
	propertyIds: []
};

const TENANT_ACTOR: TenantActor = {
	kind: 'USER',
	userId: 'tenant-user',
	role: 'TENANT',
	tenantProfileId: 'tenant-profile-1'
};

const HISTORY_SCOPE: TenantHistoryScope = {
	managedTenantId: 'mt-1',
	tenancyId: 'tenancy-1'
};

function emptySelect(): ScopedQueryDb['select'] {
	return () =>
		({
			from: () => ({
				innerJoin: () => ({
					innerJoin: () => ({
						where: () => ({
							limit: async () => []
						})
					}),
					where: () => ({
						limit: async () => []
					})
				})
			})
		}) as never;
}

function joinSelect(
	resolver: (table: unknown, depth: 'single' | 'double') => unknown[]
): ScopedQueryDb['select'] {
	return () =>
		({
			from: (table: unknown) => ({
				innerJoin: () => ({
					innerJoin: () => ({
						where: () => ({
							limit: async () => resolver(table, 'double')
						})
					}),
					where: () => ({
						limit: async () => resolver(table, 'single')
					})
				})
			})
		}) as never;
}

function queryOnlyDb(
	query: ScopedQueryDb['query'],
	select: ScopedQueryDb['select'] = emptySelect()
): ScopedQueryDb {
	return { query, select };
}

test('landlord property: missing and foreign both NotFound', async () => {
	const missingDb = queryOnlyDb({
		properties: { findFirst: async () => null }
	} as never);
	await assert.rejects(
		() => findPropertyForLandlord(missingDb, LANDLORD_A, 'property-missing'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);

	const foreignDb = queryOnlyDb({
		properties: { findFirst: async () => null }
	} as never);
	await assert.rejects(
		() => findPropertyForLandlord(foreignDb, LANDLORD_A, 'property-b1'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);

	const ownedDb = queryOnlyDb({
		properties: {
			findFirst: async () => ({ id: 'property-a1', landlordId: 'landlord-a', name: 'A' })
		}
	} as never);
	const owned = await findPropertyForLandlord(ownedDb, LANDLORD_A, 'property-a1');
	assert.equal(owned.id, 'property-a1');
});

test('landlord managed tenant cross-scope matches missing NotFound', async () => {
	const db = queryOnlyDb({
		managedTenants: { findFirst: async () => null }
	} as never);
	for (const id of ['mt-missing', 'mt-b']) {
		await assert.rejects(
			() => findManagedTenantForLandlord(db, LANDLORD_A, id),
			(err: unknown) => err instanceof ScopedResourceNotFoundError
		);
	}
});

test('landlord tenancy scoped by landlordId snapshot', async () => {
	const foreignDb = queryOnlyDb({
		tenancies: { findFirst: async () => null }
	} as never);
	await assert.rejects(
		() => findTenancyForLandlord(foreignDb, LANDLORD_A, 'tenancy-b'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);

	const ownedDb = queryOnlyDb({
		tenancies: { findFirst: async () => ({ id: 'tenancy-a', landlordId: 'landlord-a' }) }
	} as never);
	const row = await findTenancyForLandlord(ownedDb, LANDLORD_A, 'tenancy-a');
	assert.equal(row.id, 'tenancy-a');
});

test('staff without assignment or capability returns forbidden', async () => {
	const staffRoomDb = queryOnlyDb(
		{} as never,
		joinSelect((table) => {
			if (table === rooms) {
				return [{ room: { id: 'room-a1' }, propertyId: 'property-a1' }];
			}
			return [];
		})
	);

	await assert.rejects(
		() => findRoomForStaff(staffRoomDb, STAFF_UNASSIGNED, 'room-a1', 'VIEW_ROOMS'),
		(err: unknown) => {
			assert.ok(err instanceof AuthorizationError);
			assert.equal(err.status, 403);
			return true;
		}
	);

	const staffNoPerm: StaffActor = { ...STAFF_ASSIGNED, permissions: [] };
	await assert.rejects(
		() => findRoomForStaff(staffRoomDb, staffNoPerm, 'room-a1', 'VIEW_ROOMS'),
		(err: unknown) => {
			assert.ok(err instanceof AuthorizationError);
			assert.equal(err.status, 403);
			return true;
		}
	);
});

test('tenant history requires claimant and tenancy scope from DB', async () => {
	const successDb = queryOnlyDb({
		managedTenants: {
			findFirst: async () => ({ id: HISTORY_SCOPE.managedTenantId })
		},
		tenancies: {
			findFirst: async () => ({ id: HISTORY_SCOPE.tenancyId })
		},
		invoices: {
			findFirst: async () => ({
				id: 'inv-1',
				managedTenantId: HISTORY_SCOPE.managedTenantId,
				tenancyId: HISTORY_SCOPE.tenancyId
			})
		}
	} as never);

	const invoice = await findInvoiceForTenantHistory(
		successDb,
		TENANT_ACTOR,
		HISTORY_SCOPE,
		'inv-1'
	);
	assert.equal(invoice.id, 'inv-1');

	const unclaimedDb = queryOnlyDb({
		managedTenants: { findFirst: async () => null },
		tenancies: { findFirst: async () => null },
		invoices: { findFirst: async () => null }
	} as never);
	await assert.rejects(
		() =>
			findInvoiceForTenantHistory(
				unclaimedDb,
				{ ...TENANT_ACTOR, userId: 'other-user' },
				HISTORY_SCOPE,
				'inv-1'
			),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);

	const wrongScopeDb = queryOnlyDb({
		managedTenants: { findFirst: async () => ({ id: HISTORY_SCOPE.managedTenantId }) },
		tenancies: { findFirst: async () => ({ id: HISTORY_SCOPE.tenancyId }) },
		invoices: { findFirst: async () => null }
	} as never);
	for (const id of ['inv-foreign', 'inv-missing']) {
		await assert.rejects(
			() => findInvoiceForTenantHistory(wrongScopeDb, TENANT_ACTOR, HISTORY_SCOPE, id),
			(err: unknown) => err instanceof ScopedResourceNotFoundError
		);
	}
});

test('tenant history contract uses managedTenantId + tenancyId snapshot', async () => {
	const db = queryOnlyDb({
		managedTenants: { findFirst: async () => ({ id: HISTORY_SCOPE.managedTenantId }) },
		tenancies: { findFirst: async () => ({ id: HISTORY_SCOPE.tenancyId }) },
		contracts: {
			findFirst: async () => ({
				id: 'contract-1',
				managedTenantId: HISTORY_SCOPE.managedTenantId,
				tenancyId: HISTORY_SCOPE.tenancyId
			})
		}
	} as never);

	const contract = await findContractForTenantHistory(
		db,
		TENANT_ACTOR,
		HISTORY_SCOPE,
		'contract-1'
	);
	assert.equal(contract.id, 'contract-1');
});

test('landlord payment account scoped by landlordId column', async () => {
	const foreignDb = queryOnlyDb({
		paymentAccounts: { findFirst: async () => null }
	} as never);
	await assert.rejects(
		() => findPaymentAccountForLandlord(foreignDb, LANDLORD_B, 'pay-a'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);

	const ownedDb = queryOnlyDb({
		paymentAccounts: { findFirst: async () => ({ id: 'pay-a', landlordId: 'landlord-a' }) }
	} as never);
	const account = await findPaymentAccountForLandlord(ownedDb, LANDLORD_A, 'pay-a');
	assert.equal(account.id, 'pay-a');
});

test('landlord join helpers isolate landlord B from landlord A resources', async () => {
	const ownedJoinDb = queryOnlyDb(
		{} as never,
		joinSelect((table, depth) => {
			if (table === rooms) return [{ room: { id: 'room-a1' } }];
			if (table === invoices && depth === 'double') return [{ invoice: { id: 'inv-a' } }];
			if (table === contracts && depth === 'double') return [{ contract: { id: 'ctr-a' } }];
			if (table === meterReadings && depth === 'double') {
				return [{ meterReading: { id: 'meter-a' } }];
			}
			if (table === maintenanceRequests && depth === 'single') {
				return [{ request: { id: 'req-a' } }];
			}
			return [];
		})
	);

	assert.equal((await findRoomForLandlord(ownedJoinDb, LANDLORD_A, 'room-a1')).id, 'room-a1');
	assert.equal((await findInvoiceForLandlord(ownedJoinDb, LANDLORD_A, 'inv-a')).id, 'inv-a');
	assert.equal((await findContractForLandlord(ownedJoinDb, LANDLORD_A, 'ctr-a')).id, 'ctr-a');
	assert.equal(
		(await findMeterReadingForLandlord(ownedJoinDb, LANDLORD_A, 'meter-a')).id,
		'meter-a'
	);
	assert.equal(
		(await findMaintenanceRequestForLandlord(ownedJoinDb, LANDLORD_A, 'req-a')).id,
		'req-a'
	);

	const emptyJoinDb = queryOnlyDb(
		{} as never,
		joinSelect(() => [])
	);
	for (const fn of [
		() => findRoomForLandlord(emptyJoinDb, LANDLORD_B, 'room-a1'),
		() => findInvoiceForLandlord(emptyJoinDb, LANDLORD_B, 'inv-a'),
		() => findContractForLandlord(emptyJoinDb, LANDLORD_B, 'ctr-a'),
		() => findMeterReadingForLandlord(emptyJoinDb, LANDLORD_B, 'meter-a'),
		() => findMaintenanceRequestForLandlord(emptyJoinDb, LANDLORD_B, 'req-a')
	]) {
		await assert.rejects(fn, (err: unknown) => err instanceof ScopedResourceNotFoundError);
	}
});

test('room asset child mutation binds asset to room and landlord', async () => {
	const ownedAssetDb = queryOnlyDb(
		{} as never,
		joinSelect((table, depth) => {
			if (table === roomAssets && depth === 'double') {
				return [{ asset: { id: 'asset-1', roomId: 'room-a1' } }];
			}
			return [];
		})
	);

	const asset = await findRoomAssetForLandlord(ownedAssetDb, LANDLORD_A, {
		roomId: 'room-a1',
		assetId: 'asset-1'
	});
	assert.equal(asset.id, 'asset-1');

	const emptyAssetDb = queryOnlyDb(
		{} as never,
		joinSelect(() => [])
	);
	await assert.rejects(
		() =>
			findRoomAssetForLandlord(emptyAssetDb, LANDLORD_A, {
				roomId: 'room-other',
				assetId: 'asset-1'
			}),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);
	await assert.rejects(
		() =>
			findRoomAssetForLandlord(emptyAssetDb, LANDLORD_B, {
				roomId: 'room-a1',
				assetId: 'asset-1'
			}),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);
});

test('assigned staff can load scoped room', async () => {
	const db = queryOnlyDb(
		{} as never,
		joinSelect((table) => {
			if (table === rooms) {
				return [{ room: { id: 'room-a1' }, propertyId: 'property-a1' }];
			}
			return [];
		})
	);

	const room = await findRoomForStaff(db, STAFF_ASSIGNED, 'room-a1', 'VIEW_ROOMS');
	assert.equal(room.id, 'room-a1');
});
