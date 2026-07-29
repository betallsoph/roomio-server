import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import {
	contracts,
	invoices,
	maintenanceRequests,
	managedTenants,
	meterReadings,
	roomAssets,
	staffPermissions,
	tenancies
} from '../db/schema.js';
import type { LandlordActor, StaffActor, TenantActor } from './actor.js';
import { AuthorizationError } from './errors.js';
import { createDrizzleActorDb, getUserActor } from './load-user-actor.js';
import { isOperationalUserActor, operationalActorDenyReason } from './policies.js';
import {
	findContractForTenantHistory,
	findInvoiceForLandlord,
	findInvoiceForStaff,
	findInvoiceForTenantHistory,
	findMaintenanceRequestForLandlord,
	findMaintenanceRequestForStaff,
	findMaintenanceRequestForTenantHistory,
	findMeterReadingForStaff,
	findRoomAssetForLandlord,
	findRoomAssetForStaff,
	findRoomForLandlord,
	findRoomForStaff,
	findTenancyForLandlord,
	findTenancyForStaff,
	ScopedResourceNotFoundError,
	type ScopedQueryDb,
	type TenantHistoryScope
} from './scoped-queries.js';
import {
	fixtureSession,
	seedSecurityFixturesFromHandle,
	type SecurityFixtureMap
} from '../testing/security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb,
	type SecurityDbHandle
} from '../testing/test-db.js';

const skipReason = getSecurityIntegrationSkipReason();

type ScopedSqlExtensionIds = {
	managedTenantANow: string;
	managedTenantAOld: string;
	tenancyANowActive: string;
	tenancyAOldEnded: string;
	roomAssetA1: string;
};

async function seedScopedSqlExtensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<ScopedSqlExtensionIds> {
	const { ids } = fixture;
	const db = handle.db;

	const managedTenantANow = crypto.randomUUID();
	const managedTenantAOld = crypto.randomUUID();
	const tenancyANowActive = crypto.randomUUID();
	const tenancyAOldEnded = crypto.randomUUID();
	const roomAssetA1 = crypto.randomUUID();

	await db.insert(managedTenants).values([
		{
			id: managedTenantANow,
			landlordId: ids.landlordA.landlordProfileId,
			displayName: 'Managed tenant A now',
			claimedByUserId: ids.tenantANow.userId,
			legacyTenantProfileId: ids.tenantANow.tenantProfileId,
			backfillSource: 'LEGACY_TENANT_PROFILE'
		},
		{
			id: managedTenantAOld,
			landlordId: ids.landlordA.landlordProfileId,
			displayName: 'Managed tenant A old',
			claimedByUserId: ids.tenantAOld.userId,
			legacyTenantProfileId: ids.tenantAOld.tenantProfileId,
			backfillSource: 'LEGACY_TENANT_PROFILE'
		}
	]);

	await db.insert(tenancies).values([
		{
			id: tenancyANowActive,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			roomId: ids.roomA1R1.roomId,
			managedTenantId: managedTenantANow,
			status: 'ACTIVE',
			startDate: '2026-01-01',
			plannedEndDate: '2026-12-31'
		},
		{
			id: tenancyAOldEnded,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			roomId: ids.roomA1R1.roomId,
			managedTenantId: managedTenantAOld,
			status: 'ENDED',
			startDate: '2025-01-01',
			endDate: '2025-12-31'
		}
	]);

	await db
		.update(invoices)
		.set({ managedTenantId: managedTenantAOld, tenancyId: tenancyAOldEnded })
		.where(eq(invoices.id, ids.invoiceAOld.invoiceId));
	await db
		.update(invoices)
		.set({ managedTenantId: managedTenantANow, tenancyId: tenancyANowActive })
		.where(eq(invoices.id, ids.invoiceANow.invoiceId));

	await db
		.update(contracts)
		.set({ managedTenantId: managedTenantAOld, tenancyId: tenancyAOldEnded })
		.where(eq(contracts.id, ids.contractAOld.contractId));
	await db
		.update(contracts)
		.set({ managedTenantId: managedTenantANow, tenancyId: tenancyANowActive })
		.where(eq(contracts.id, ids.contractANow.contractId));

	await db
		.update(meterReadings)
		.set({ managedTenantId: managedTenantAOld, tenancyId: tenancyAOldEnded })
		.where(eq(meterReadings.id, ids.meterReadingAOld.meterReadingId));
	await db
		.update(meterReadings)
		.set({ managedTenantId: managedTenantANow, tenancyId: tenancyANowActive })
		.where(eq(meterReadings.id, ids.meterReadingANow.meterReadingId));

	await db
		.update(maintenanceRequests)
		.set({ managedTenantId: managedTenantAOld, tenancyId: tenancyAOldEnded })
		.where(eq(maintenanceRequests.id, ids.maintenanceAOld.maintenanceRequestId));
	await db
		.update(maintenanceRequests)
		.set({ managedTenantId: managedTenantANow, tenancyId: tenancyANowActive })
		.where(eq(maintenanceRequests.id, ids.maintenanceANow.maintenanceRequestId));

	await db.insert(roomAssets).values({
		id: roomAssetA1,
		roomId: ids.roomA1R1.roomId,
		name: 'Fixture AC unit',
		status: 'good'
	});

	// Scoped tenancy lookups need VIEW_TENANTS; base fixture only grants VIEW_ROOMS + MANAGE_METERS.
	await db.insert(staffPermissions).values({
		staffId: ids.staffALimited.staffProfileId,
		permission: 'VIEW_TENANTS',
		grantedByUserId: ids.landlordA.userId
	});

	return {
		managedTenantANow,
		managedTenantAOld,
		tenancyANowActive,
		tenancyAOldEnded,
		roomAssetA1
	};
}

function landlordActor(
	fixture: SecurityFixtureMap,
	which: 'landlordA' | 'landlordB'
): LandlordActor {
	const ids = fixture.ids[which];
	return {
		kind: 'USER',
		userId: ids.userId,
		role: 'LANDLORD',
		landlordId: ids.landlordProfileId
	};
}

function tenantActor(
	fixture: SecurityFixtureMap,
	which: 'tenantANow' | 'tenantAOld' | 'tenantBNow'
): TenantActor {
	const ids = fixture.ids[which];
	return {
		kind: 'USER',
		userId: ids.userId,
		role: 'TENANT',
		tenantProfileId: ids.tenantProfileId
	};
}

async function staffActorFromFixture(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap,
	which: 'staffALimited' | 'staffAEmpty' | 'staffB'
): Promise<StaffActor> {
	const actorDb = createDrizzleActorDb(handle.db);
	const session = fixtureSession(fixture, which);
	const actor = await getUserActor(session, actorDb);
	assert.equal(actor.role, 'STAFF');
	if (actor.role !== 'STAFF') {
		throw new Error('expected staff actor');
	}
	return actor;
}

function scopedDb(handle: SecurityDbHandle): ScopedQueryDb {
	return handle.db;
}

async function expectNotFound(run: () => Promise<unknown>): Promise<void> {
	await assert.rejects(run, (error: unknown) => {
		assert.ok(error instanceof ScopedResourceNotFoundError);
		assert.equal(error.status, 404);
		return true;
	});
}

async function expectForbidden(run: () => Promise<unknown>): Promise<void> {
	await assert.rejects(run, (error: unknown) => {
		assert.ok(error instanceof AuthorizationError);
		assert.equal(error.status, 403);
		return true;
	});
}

if (skipReason) {
	test('AUTH-008 scoped SQL A/B integration suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-008 scoped SQL A/B integration', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ext = await seedScopedSqlExtensions(handle, fixture);
			const ids = fixture.ids;
			const db = scopedDb(handle);

			const landlordA = landlordActor(fixture, 'landlordA');
			const landlordB = landlordActor(fixture, 'landlordB');
			const tenantANow = tenantActor(fixture, 'tenantANow');
			const tenantAOld = tenantActor(fixture, 'tenantAOld');
			const staffLimited = await staffActorFromFixture(handle, fixture, 'staffALimited');
			const staffEmpty = await staffActorFromFixture(handle, fixture, 'staffAEmpty');
			assert.ok(staffLimited.permissions.includes('VIEW_TENANTS'));

			const historyNow: TenantHistoryScope = {
				managedTenantId: ext.managedTenantANow,
				tenancyId: ext.tenancyANowActive
			};
			const historyOld: TenantHistoryScope = {
				managedTenantId: ext.managedTenantAOld,
				tenancyId: ext.tenancyAOldEnded
			};

			await t.test('landlord A/B isolation: foreign invoice and room return NotFound', async () => {
				const ownInvoice = await findInvoiceForLandlord(db, landlordA, ids.invoiceANow.invoiceId);
				assert.equal(ownInvoice.id, ids.invoiceANow.invoiceId);

				await expectNotFound(() =>
					findInvoiceForLandlord(db, landlordA, ids.invoiceBNow.invoiceId)
				);
				await expectNotFound(() =>
					findInvoiceForLandlord(db, landlordB, ids.invoiceANow.invoiceId)
				);
				await expectNotFound(() => findRoomForLandlord(db, landlordB, ids.roomA1R1.roomId));
			});

			await t.test(
				'child-parent mix: room asset bound to wrong room returns NotFound',
				async () => {
					const asset = await findRoomAssetForLandlord(db, landlordA, {
						roomId: ids.roomA1R1.roomId,
						assetId: ext.roomAssetA1
					});
					assert.equal(asset.id, ext.roomAssetA1);

					await expectNotFound(() =>
						findRoomAssetForLandlord(db, landlordA, {
							roomId: ids.roomB1R1.roomId,
							assetId: ext.roomAssetA1
						})
					);
					await expectNotFound(() =>
						findRoomAssetForLandlord(db, landlordB, {
							roomId: ids.roomA1R1.roomId,
							assetId: ext.roomAssetA1
						})
					);
				}
			);

			await t.test('staff outside property assignment returns 403', async () => {
				await expectForbidden(() =>
					findRoomForStaff(db, staffLimited, ids.roomA2R1.roomId, 'VIEW_ROOMS')
				);
				await expectForbidden(() =>
					findRoomAssetForStaff(
						db,
						staffLimited,
						{ roomId: ids.roomA2R1.roomId, assetId: ext.roomAssetA1 },
						'VIEW_ROOMS'
					)
				);
			});

			await t.test('staff missing capability on in-scope resource returns 403', async () => {
				await expectForbidden(() =>
					findInvoiceForStaff(db, staffLimited, ids.invoiceANow.invoiceId, 'VIEW_TENANTS')
				);
				await expectForbidden(() =>
					findMaintenanceRequestForStaff(
						db,
						staffLimited,
						ids.maintenanceANow.maintenanceRequestId,
						'MANAGE_REQUESTS'
					)
				);

				const meter = await findMeterReadingForStaff(
					db,
					staffLimited,
					ids.meterReadingANow.meterReadingId,
					'MANAGE_METERS'
				);
				assert.equal(meter.id, ids.meterReadingANow.meterReadingId);
			});

			await t.test('staff with no assignments returns 403 before scoped SQL', async () => {
				await expectForbidden(() =>
					findRoomForStaff(db, staffEmpty, ids.roomA1R1.roomId, 'VIEW_ROOMS')
				);
			});

			await t.test('staff tenancy lookup requires ACTIVE status', async () => {
				await expectNotFound(() =>
					findTenancyForStaff(db, staffLimited, ext.tenancyAOldEnded, 'VIEW_TENANTS')
				);

				const active = await findTenancyForStaff(
					db,
					staffLimited,
					ext.tenancyANowActive,
					'VIEW_TENANTS'
				);
				assert.equal(active.id, ext.tenancyANowActive);
			});

			await t.test('tenant history: claimant + managedTenantId + tenancyId snapshot', async () => {
				const invoice = await findInvoiceForTenantHistory(
					db,
					tenantANow,
					historyNow,
					ids.invoiceANow.invoiceId
				);
				assert.equal(invoice.id, ids.invoiceANow.invoiceId);

				const contract = await findContractForTenantHistory(
					db,
					tenantANow,
					historyNow,
					ids.contractANow.contractId
				);
				assert.equal(contract.id, ids.contractANow.contractId);

				const request = await findMaintenanceRequestForTenantHistory(
					db,
					tenantANow,
					historyNow,
					ids.maintenanceANow.maintenanceRequestId
				);
				assert.equal(request.id, ids.maintenanceANow.maintenanceRequestId);

				await expectNotFound(() =>
					findInvoiceForTenantHistory(db, tenantAOld, historyNow, ids.invoiceANow.invoiceId)
				);
				await expectNotFound(() =>
					findInvoiceForTenantHistory(db, tenantANow, historyNow, ids.invoiceAOld.invoiceId)
				);
			});

			await t.test(
				'current occupant change: stale occupant cannot read successor history',
				async () => {
					const oldInvoice = await findInvoiceForTenantHistory(
						db,
						tenantAOld,
						historyOld,
						ids.invoiceAOld.invoiceId
					);
					assert.equal(oldInvoice.id, ids.invoiceAOld.invoiceId);

					await expectNotFound(() =>
						findInvoiceForTenantHistory(db, tenantAOld, historyNow, ids.invoiceANow.invoiceId)
					);
					await expectNotFound(() =>
						findInvoiceForTenantHistory(db, tenantANow, historyOld, ids.invoiceAOld.invoiceId)
					);
				}
			);

			await t.test('landlord tenancy and maintenance scoped via tenancy join', async () => {
				const tenancy = await findTenancyForLandlord(db, landlordA, ext.tenancyANowActive);
				assert.equal(tenancy.id, ext.tenancyANowActive);

				const request = await findMaintenanceRequestForLandlord(
					db,
					landlordA,
					ids.maintenanceANow.maintenanceRequestId
				);
				assert.equal(request.id, ids.maintenanceANow.maintenanceRequestId);

				await expectNotFound(() =>
					findMaintenanceRequestForLandlord(db, landlordB, ids.maintenanceANow.maintenanceRequestId)
				);
			});

			await t.test(
				'super admin must not slip through operational scoped-query boundary',
				async () => {
					const actorDb = createDrizzleActorDb(handle.db);
					const superAdmin = await getUserActor(fixtureSession(fixture, 'superAdmin'), actorDb);
					assert.equal(superAdmin.role, 'SUPER_ADMIN');
					assert.equal(isOperationalUserActor(superAdmin), false);
					assert.equal(operationalActorDenyReason(superAdmin), 'SUPER_ADMIN_OPERATIONAL');
				}
			);
		});
	});
}
