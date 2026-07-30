import assert from 'node:assert/strict';
import test from 'node:test';
import { contracts, invoices, roomAssets, rooms, services } from '$lib/server/db/schema';
import type { LandlordActor, StaffActor, SuperAdminActor, TenantActor } from './actor.js';
import { AuthorizationError } from './errors.js';
import {
	ScopedResourceNotFoundError,
	findContractForLandlord,
	findContractForTenantHistory,
	findInvoiceForLandlord,
	findInvoiceForTenantHistory,
	findManagedTenantForLandlord,
	findManagedTenantForTenant,
	findMaintenanceRequestForLandlord,
	findMeterReadingForLandlord,
	findPaymentAccountForLandlord,
	findPaymentAccountForTenantHistory,
	findPropertyForLandlord,
	findPropertyForTenant,
	findRoomAssetForLandlord,
	findRoomForLandlord,
	findRoomForStaff,
	findRoomForTenant,
	findServiceForLandlord,
	findServiceForStaff,
	findServiceForTenant,
	findTenancyForLandlord,
	findTenancyForStaff,
	findTenancyForTenant,
	isOperationalUserActor,
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

const SUPER_ADMIN: SuperAdminActor = {
	kind: 'USER',
	userId: 'super-admin',
	role: 'SUPER_ADMIN'
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
						innerJoin: () => ({
							where: () => ({
								limit: async () => []
							})
						}),
						where: () => ({
							limit: async () => []
						})
					}),
					where: () => ({
						limit: async () => []
					})
				}),
				where: () => ({
					limit: async () => []
				})
			})
		}) as never;
}

function joinSelect(
	resolver: (table: unknown, depth: 'single' | 'double' | 'triple' | 'plain') => unknown[]
): ScopedQueryDb['select'] {
	return () =>
		({
			from: (table: unknown) => ({
				innerJoin: () => ({
					innerJoin: () => ({
						innerJoin: () => ({
							where: () => ({
								limit: async () => resolver(table, 'triple')
							})
						}),
						where: () => ({
							limit: async () => resolver(table, 'double')
						})
					}),
					where: () => ({
						limit: async () => resolver(table, 'single')
					})
				}),
				where: () => ({
					limit: async () => resolver(table, 'plain')
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

test('staff tenancy requires ACTIVE status (ended ≡ missing)', async () => {
	const staffViewer: StaffActor = {
		...STAFF_ASSIGNED,
		permissions: ['VIEW_TENANTS']
	};

	const activeDb = queryOnlyDb({
		tenancies: {
			findFirst: async () => ({
				id: 'tenancy-active',
				landlordId: 'landlord-a',
				propertyId: 'property-a1',
				status: 'ACTIVE'
			})
		}
	} as never);
	const active = await findTenancyForStaff(activeDb, staffViewer, 'tenancy-active');
	assert.equal(active.id, 'tenancy-active');

	const endedDb = queryOnlyDb({
		tenancies: { findFirst: async () => null }
	} as never);
	for (const id of ['tenancy-ended', 'tenancy-missing']) {
		await assert.rejects(
			() => findTenancyForStaff(endedDb, staffViewer, id),
			(err: unknown) => err instanceof ScopedResourceNotFoundError
		);
	}
});

test('staff outside assignment is NotFound; missing capability on assigned resource is forbidden', async () => {
	const staffRoomDb = queryOnlyDb(
		{} as never,
		joinSelect((table) => {
			if (table === rooms) {
				return [{ room: { id: 'room-a1' } }];
			}
			return [];
		})
	);

	const staffRoomDbUnassigned = queryOnlyDb(
		{} as never,
		joinSelect(() => [])
	);

	await assert.rejects(
		() => findRoomForStaff(staffRoomDbUnassigned, STAFF_UNASSIGNED, 'room-a1'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);

	const staffNoPerm: StaffActor = { ...STAFF_ASSIGNED, permissions: [] };
	await assert.rejects(
		() => findRoomForStaff(staffRoomDb, staffNoPerm, 'room-a1'),
		(err: unknown) => {
			assert.ok(err instanceof AuthorizationError);
			assert.equal(err.status, 403);
			return true;
		}
	);
});

test('staff service read requires assignment and operational capability', async () => {
	const serviceDb = queryOnlyDb(
		{} as never,
		joinSelect((table, depth) => {
			if (table === services && depth === 'triple') {
				return [{ service: { id: 'svc-1', landlordId: 'landlord-a', name: 'Điện' } }];
			}
			return [];
		})
	);

	const reader: StaffActor = { ...STAFF_ASSIGNED, permissions: ['VIEW_ROOMS'] };
	assert.equal((await findServiceForStaff(serviceDb, reader, 'svc-1')).id, 'svc-1');

	const serviceDbUnassigned = queryOnlyDb(
		{} as never,
		joinSelect(() => [])
	);
	await assert.rejects(
		() => findServiceForStaff(serviceDbUnassigned, STAFF_UNASSIGNED, 'svc-1'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);

	const noCap: StaffActor = { ...STAFF_ASSIGNED, permissions: ['VIEW_TENANTS'] };
	await assert.rejects(
		() => findServiceForStaff(serviceDb, noCap, 'svc-1'),
		(err: unknown) => {
			assert.ok(err instanceof AuthorizationError);
			assert.equal(err.status, 403);
			return true;
		}
	);
});

test('staff MANAGE_METERS-only can property-read via owned PROPERTY_READ gate', async () => {
	const db = queryOnlyDb(
		{} as never,
		joinSelect((table) => {
			if (table === rooms) {
				return [{ room: { id: 'room-a1' } }];
			}
			return [];
		})
	);

	const meterStaff: StaffActor = {
		...STAFF_ASSIGNED,
		permissions: ['MANAGE_METERS']
	};
	const room = await findRoomForStaff(db, meterStaff, 'room-a1');
	assert.equal(room.id, 'room-a1');
});

test('tenant history rejects suspended claim access', async () => {
	const suspendedDb = queryOnlyDb({
		managedTenants: { findFirst: async () => null },
		tenancies: { findFirst: async () => null },
		invoices: { findFirst: async () => null }
	} as never);

	await assert.rejects(
		() => findInvoiceForTenantHistory(suspendedDb, TENANT_ACTOR, HISTORY_SCOPE, 'inv-1'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);
});

test('tenant history requires claimant and tenancy scope from DB', async () => {
	const successDb = queryOnlyDb({
		managedTenants: {
			findFirst: async () => ({ id: HISTORY_SCOPE.managedTenantId })
		},
		tenancies: {
			findFirst: async () => ({
				id: HISTORY_SCOPE.tenancyId,
				managedTenantId: HISTORY_SCOPE.managedTenantId,
				status: 'ACTIVE',
				landlordId: 'landlord-a',
				propertyId: 'property-a1',
				roomId: 'room-a1'
			})
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

test('tenant scoped property and room bind to active tenancy snapshot', async () => {
	const db = queryOnlyDb({
		managedTenants: { findFirst: async () => ({ id: HISTORY_SCOPE.managedTenantId }) },
		tenancies: {
			findFirst: async () => ({
				id: HISTORY_SCOPE.tenancyId,
				managedTenantId: HISTORY_SCOPE.managedTenantId,
				status: 'ACTIVE',
				landlordId: 'landlord-a',
				propertyId: 'property-a1',
				roomId: 'room-a1'
			})
		},
		properties: {
			findFirst: async () => ({ id: 'property-a1', landlordId: 'landlord-a' })
		}
	} as never);

	const property = await findPropertyForTenant(db, TENANT_ACTOR, HISTORY_SCOPE, 'property-a1');
	assert.equal(property.id, 'property-a1');

	const roomDb = queryOnlyDb(
		{
			managedTenants: { findFirst: async () => ({ id: HISTORY_SCOPE.managedTenantId }) },
			tenancies: {
				findFirst: async () => ({
					id: HISTORY_SCOPE.tenancyId,
					managedTenantId: HISTORY_SCOPE.managedTenantId,
					status: 'ACTIVE',
					landlordId: 'landlord-a',
					propertyId: 'property-a1',
					roomId: 'room-a1'
				})
			}
		} as never,
		joinSelect((table) => {
			if (table === rooms) return [{ room: { id: 'room-a1' } }];
			return [];
		})
	);
	const room = await findRoomForTenant(roomDb, TENANT_ACTOR, HISTORY_SCOPE, 'room-a1');
	assert.equal(room.id, 'room-a1');

	await assert.rejects(
		() => findPropertyForTenant(db, TENANT_ACTOR, HISTORY_SCOPE, 'property-other'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);
});

test('tenant managed tenant and service require claimant scope and room service binding', async () => {
	const db = queryOnlyDb(
		{
			managedTenants: {
				findFirst: async () => ({ id: 'mt-1', claimedByUserId: TENANT_ACTOR.userId })
			},
			tenancies: {
				findFirst: async () => ({
					id: HISTORY_SCOPE.tenancyId,
					managedTenantId: HISTORY_SCOPE.managedTenantId,
					status: 'ACTIVE',
					landlordId: 'landlord-a',
					propertyId: 'property-a1',
					roomId: 'room-a1'
				})
			}
		} as never,
		joinSelect((table, depth) => {
			if (table === services && depth === 'double') {
				return [{ service: { id: 'svc-1', landlordId: 'landlord-a' } }];
			}
			return [];
		})
	);

	const managedTenant = await findManagedTenantForTenant(db, TENANT_ACTOR, 'mt-1');
	assert.equal(managedTenant.id, 'mt-1');

	const service = await findServiceForTenant(db, TENANT_ACTOR, HISTORY_SCOPE, 'svc-1');
	assert.equal(service.id, 'svc-1');

	const tenancy = await findTenancyForTenant(db, TENANT_ACTOR, HISTORY_SCOPE);
	assert.equal(tenancy.id, HISTORY_SCOPE.tenancyId);
});

test('landlord payment account returns safe projection without PayOS secrets', async () => {
	const foreignDb = queryOnlyDb({
		paymentAccounts: { findFirst: async () => null }
	} as never);
	await assert.rejects(
		() => findPaymentAccountForLandlord(foreignDb, LANDLORD_B, 'pay-a'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);

	const ownedDb = queryOnlyDb({
		paymentAccounts: {
			findFirst: async () => ({
				id: 'pay-a',
				landlordId: 'landlord-a',
				name: 'VietQR',
				provider: 'vietqr',
				isDefault: true,
				isActive: true,
				bankName: 'VCB',
				bankCode: '970436',
				accountNumber: '123',
				accountName: 'A',
				bankBranch: null,
				momoNumber: null,
				payosClientId: null,
				payosConnectedAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z')
			})
		}
	} as never);
	const account = await findPaymentAccountForLandlord(ownedDb, LANDLORD_A, 'pay-a');
	assert.equal(account.id, 'pay-a');
	assert.equal('payosApiKeyEnc' in account, false);
	assert.equal('payosChecksumKeyEnc' in account, false);
});

test('tenant payment account binds via invoice→tenancy→account landlord match', async () => {
	const safeAccount = {
		id: 'pay-a',
		landlordId: 'landlord-a',
		name: 'VietQR',
		provider: 'vietqr',
		isDefault: true,
		isActive: true,
		bankName: 'VCB',
		bankCode: '970436',
		accountNumber: '123',
		accountName: 'A',
		bankBranch: null,
		momoNumber: null,
		payosClientId: null,
		payosConnectedAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z')
	};

	const successDb = queryOnlyDb(
		{
			managedTenants: { findFirst: async () => ({ id: HISTORY_SCOPE.managedTenantId }) },
			tenancies: { findFirst: async () => ({ id: HISTORY_SCOPE.tenancyId }) }
		} as never,
		joinSelect((table, depth) => {
			if (table === invoices && depth === 'double') return [safeAccount];
			return [];
		})
	);

	const account = await findPaymentAccountForTenantHistory(
		successDb,
		TENANT_ACTOR,
		HISTORY_SCOPE,
		'inv-1'
	);
	assert.equal(account.id, 'pay-a');
	assert.equal('payosApiKeyEnc' in account, false);

	// Cross-landlord paymentAccountId on in-scope invoice → join miss → 404
	const crossLandlordDb = queryOnlyDb(
		{
			managedTenants: { findFirst: async () => ({ id: HISTORY_SCOPE.managedTenantId }) },
			tenancies: { findFirst: async () => ({ id: HISTORY_SCOPE.tenancyId }) }
		} as never,
		joinSelect(() => [])
	);
	await assert.rejects(
		() => findPaymentAccountForTenantHistory(crossLandlordDb, TENANT_ACTOR, HISTORY_SCOPE, 'inv-1'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);
});

test('landlord join helpers isolate landlord B from landlord A resources', async () => {
	const ownedJoinDb = queryOnlyDb(
		{
			meterReadings: {
				findFirst: async () => ({
					id: 'meter-a',
					landlordId: 'landlord-a',
					propertyId: 'property-a1'
				})
			},
			maintenanceRequests: {
				findFirst: async () => ({
					id: 'req-a',
					landlordId: 'landlord-a',
					propertyId: 'property-a1'
				})
			}
		} as never,
		joinSelect((table, depth) => {
			if (table === rooms) return [{ room: { id: 'room-a1' } }];
			if (table === invoices && depth === 'double') return [{ invoice: { id: 'inv-a' } }];
			if (table === contracts && depth === 'double') return [{ contract: { id: 'ctr-a' } }];
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
		{
			meterReadings: { findFirst: async () => null },
			maintenanceRequests: { findFirst: async () => null }
		} as never,
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

test('landlord service catalog scoped by landlordId', async () => {
	const db = queryOnlyDb({
		services: { findFirst: async () => ({ id: 'svc-a', landlordId: 'landlord-a' }) }
	} as never);
	assert.equal((await findServiceForLandlord(db, LANDLORD_A, 'svc-a')).id, 'svc-a');

	const foreignDb = queryOnlyDb({
		services: { findFirst: async () => null }
	} as never);
	await assert.rejects(
		() => findServiceForLandlord(foreignDb, LANDLORD_B, 'svc-a'),
		(err: unknown) => err instanceof ScopedResourceNotFoundError
	);
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
				return [{ room: { id: 'room-a1' } }];
			}
			return [];
		})
	);

	const room = await findRoomForStaff(db, STAFF_ASSIGNED, 'room-a1');
	assert.equal(room.id, 'room-a1');
});

test('scoped helpers reject SuperAdmin at operational boundary', () => {
	type ExpectLandlordOnly = Parameters<typeof findPropertyForLandlord>[1];
	type ExpectStaffOnly = Parameters<typeof findRoomForStaff>[1];
	type ExpectTenantOnly = Parameters<typeof findManagedTenantForTenant>[1];

	const _landlordGuard: ExpectLandlordOnly = LANDLORD_A;
	const _staffGuard: ExpectStaffOnly = STAFF_ASSIGNED;
	const _tenantGuard: ExpectTenantOnly = TENANT_ACTOR;

	assert.equal(isOperationalUserActor(SUPER_ADMIN), false);
	assert.equal(isOperationalUserActor(LANDLORD_A), true);
	assert.equal(isOperationalUserActor(STAFF_ASSIGNED), true);
	assert.equal(isOperationalUserActor(TENANT_ACTOR), true);

	// SuperAdmin lacks landlord/staff/tenant scope fields — TypeScript blocks direct helper calls.
	assert.equal(SUPER_ADMIN.role, 'SUPER_ADMIN');
	assert.notEqual((_landlordGuard as { landlordId?: string }).landlordId, undefined);
	assert.notEqual((_staffGuard as { propertyIds?: string[] }).propertyIds, undefined);
	assert.notEqual((_tenantGuard as { userId?: string }).userId, undefined);
	assert.equal((SUPER_ADMIN as { landlordId?: string }).landlordId, undefined);
});
