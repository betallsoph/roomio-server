import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq, sql } from 'drizzle-orm';
import {
	contracts,
	invoices,
	maintenanceRequests,
	managedTenants,
	meterReadings,
	roomAssets,
	roomServiceConfigs,
	staffPermissions,
	tenancies
} from '../db/schema.js';
import type { LandlordActor, StaffActor, TenantActor } from './actor.js';
import { AuthorizationError } from './errors.js';
import { createDrizzleActorDb, getUserActor } from './load-user-actor.js';
import { operationalActorDenyReason } from './policies.js';
import {
	findContractForLandlord,
	findContractForTenantHistory,
	findInvoiceForLandlord,
	findInvoiceForTenantHistory,
	findMaintenanceRequestForLandlord,
	findMaintenanceRequestForStaff,
	findMaintenanceRequestForTenantHistory,
	findManagedTenantForLandlord,
	findManagedTenantForStaff,
	findManagedTenantForTenant,
	findMeterReadingForLandlord,
	findMeterReadingForStaff,
	findMeterReadingForTenantHistory,
	findPaymentAccountForLandlord,
	findPaymentAccountForTenantHistory,
	findPropertyForLandlord,
	findPropertyForStaff,
	findPropertyForTenant,
	findRoomAssetForLandlord,
	findRoomAssetForStaff,
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
		.set({
			managedTenantId: managedTenantAOld,
			tenancyId: tenancyAOldEnded,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId
		})
		.where(eq(meterReadings.id, ids.meterReadingAOld.meterReadingId));
	await db
		.update(meterReadings)
		.set({
			managedTenantId: managedTenantANow,
			tenancyId: tenancyANowActive,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId
		})
		.where(eq(meterReadings.id, ids.meterReadingANow.meterReadingId));

	await db
		.update(maintenanceRequests)
		.set({
			managedTenantId: managedTenantAOld,
			tenancyId: tenancyAOldEnded,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			roomId: ids.roomA1R1.roomId
		})
		.where(eq(maintenanceRequests.id, ids.maintenanceAOld.maintenanceRequestId));
	await db
		.update(maintenanceRequests)
		.set({
			managedTenantId: managedTenantANow,
			tenancyId: tenancyANowActive,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			roomId: ids.roomA1R1.roomId
		})
		.where(eq(maintenanceRequests.id, ids.maintenanceANow.maintenanceRequestId));

	await db.insert(roomAssets).values({
		id: roomAssetA1,
		roomId: ids.roomA1R1.roomId,
		name: 'Fixture AC unit',
		status: 'good'
	});

	await db.insert(roomServiceConfigs).values({
		id: crypto.randomUUID(),
		roomId: ids.roomA1R1.roomId,
		serviceId: ids.serviceA.serviceId
	});

	await db.insert(staffPermissions).values({
		staffId: ids.staffALimited.staffProfileId,
		permission: 'VIEW_TENANTS',
		grantedByUserId: ids.landlordA.userId
	});

	// Secrets exist in DB but scoped helpers must never project them.
	await db.execute(sql`
		UPDATE "PaymentAccount"
		SET "payosApiKeyEnc" = 'secret-api-key',
		    "payosChecksumKeyEnc" = 'secret-checksum'
		WHERE "id" = ${ids.paymentAccountA.paymentAccountId}
	`);

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
	const row = fixture.ids[which];
	return {
		kind: 'USER',
		userId: row.userId,
		role: 'LANDLORD',
		landlordId: row.landlordProfileId
	};
}

function tenantActor(
	fixture: SecurityFixtureMap,
	which: 'tenantANow' | 'tenantAOld' | 'tenantBNow'
): TenantActor {
	const row = fixture.ids[which];
	return {
		kind: 'USER',
		userId: row.userId,
		role: 'TENANT',
		tenantProfileId: row.tenantProfileId
	};
}

async function staffActorFromFixture(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap,
	which: 'staffALimited' | 'staffAEmpty'
): Promise<StaffActor> {
	const actorDb = createDrizzleActorDb(handle.db);
	const actor = await getUserActor(fixtureSession(fixture, which), actorDb);
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
				}
			);

			await t.test('staff outside property assignment returns NotFound', async () => {
				await expectNotFound(() => findRoomForStaff(db, staffLimited, ids.roomA2R1.roomId));
				await expectNotFound(() =>
					findRoomAssetForStaff(db, staffLimited, {
						roomId: ids.roomA2R1.roomId,
						assetId: ext.roomAssetA1
					})
				);
				await expectNotFound(() => findServiceForStaff(db, staffEmpty, ids.serviceA.serviceId));
			});

			await t.test('staff missing capability on in-scope resource returns 403', async () => {
				const staffNoPropertyRead: StaffActor = {
					...staffLimited,
					permissions: []
				};
				await expectForbidden(() => findRoomForStaff(db, staffNoPropertyRead, ids.roomA1R1.roomId));
				await expectForbidden(() =>
					findMaintenanceRequestForStaff(db, staffLimited, ids.maintenanceANow.maintenanceRequestId)
				);
				await expectForbidden(() =>
					findServiceForStaff(db, staffNoPropertyRead, ids.serviceA.serviceId)
				);

				const meter = await findMeterReadingForStaff(
					db,
					staffLimited,
					ids.meterReadingANow.meterReadingId
				);
				assert.equal(meter.id, ids.meterReadingANow.meterReadingId);
			});

			await t.test(
				'staff MANAGE_METERS can property-read assigned room via owned gate',
				async () => {
					const meterStaff: StaffActor = {
						...staffLimited,
						permissions: ['MANAGE_METERS']
					};
					const room = await findRoomForStaff(db, meterStaff, ids.roomA1R1.roomId);
					assert.equal(room.id, ids.roomA1R1.roomId);
				}
			);

			await t.test('staff tenancy lookup requires ACTIVE status', async () => {
				await expectNotFound(() => findTenancyForStaff(db, staffLimited, ext.tenancyAOldEnded));

				const active = await findTenancyForStaff(db, staffLimited, ext.tenancyANowActive);
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

			await t.test('tenant property/room/service scoped via active tenancy binding', async () => {
				const managedTenant = await findManagedTenantForTenant(
					db,
					tenantANow,
					ext.managedTenantANow
				);
				assert.equal(managedTenant.id, ext.managedTenantANow);

				const tenancy = await findTenancyForTenant(db, tenantANow, historyNow);
				assert.equal(tenancy.id, ext.tenancyANowActive);

				const property = await findPropertyForTenant(
					db,
					tenantANow,
					historyNow,
					ids.propertyA1.propertyId
				);
				assert.equal(property.id, ids.propertyA1.propertyId);

				const room = await findRoomForTenant(db, tenantANow, historyNow, ids.roomA1R1.roomId);
				assert.equal(room.id, ids.roomA1R1.roomId);

				const service = await findServiceForTenant(
					db,
					tenantANow,
					historyNow,
					ids.serviceA.serviceId
				);
				assert.equal(service.id, ids.serviceA.serviceId);

				await expectNotFound(() =>
					findPropertyForTenant(db, tenantANow, historyNow, ids.propertyB1.propertyId)
				);
			});

			await t.test('landlord contract and maintenance scoped via joins', async () => {
				const contract = await findContractForLandlord(db, landlordA, ids.contractANow.contractId);
				assert.equal(contract.id, ids.contractANow.contractId);

				const request = await findMaintenanceRequestForLandlord(
					db,
					landlordA,
					ids.maintenanceANow.maintenanceRequestId
				);
				assert.equal(request.id, ids.maintenanceANow.maintenanceRequestId);

				const tenancy = await findTenancyForLandlord(db, landlordA, ext.tenancyANowActive);
				assert.equal(tenancy.id, ext.tenancyANowActive);

				await expectNotFound(() =>
					findContractForLandlord(db, landlordB, ids.contractANow.contractId)
				);
			});

			await t.test(
				'matrix: landlord property/managedTenant/service/meter/payment own vs foreign',
				async () => {
					assert.equal(
						(await findPropertyForLandlord(db, landlordA, ids.propertyA1.propertyId)).id,
						ids.propertyA1.propertyId
					);
					await expectNotFound(() =>
						findPropertyForLandlord(db, landlordA, ids.propertyB1.propertyId)
					);

					assert.equal(
						(await findManagedTenantForLandlord(db, landlordA, ext.managedTenantANow)).id,
						ext.managedTenantANow
					);
					await expectNotFound(() =>
						findManagedTenantForLandlord(db, landlordB, ext.managedTenantANow)
					);

					assert.equal(
						(await findServiceForLandlord(db, landlordA, ids.serviceA.serviceId)).id,
						ids.serviceA.serviceId
					);
					await expectNotFound(() => findServiceForLandlord(db, landlordB, ids.serviceA.serviceId));

					assert.equal(
						(await findMeterReadingForLandlord(db, landlordA, ids.meterReadingANow.meterReadingId))
							.id,
						ids.meterReadingANow.meterReadingId
					);
					await expectNotFound(() =>
						findMeterReadingForLandlord(db, landlordB, ids.meterReadingANow.meterReadingId)
					);

					const payA = await findPaymentAccountForLandlord(
						db,
						landlordA,
						ids.paymentAccountA.paymentAccountId
					);
					assert.equal(payA.id, ids.paymentAccountA.paymentAccountId);
					assert.equal('payosApiKeyEnc' in payA, false);
					assert.equal('payosChecksumKeyEnc' in payA, false);
					await expectNotFound(() =>
						findPaymentAccountForLandlord(db, landlordB, ids.paymentAccountA.paymentAccountId)
					);
				}
			);

			await t.test('matrix: staff property / managedTenant own vs foreign assignment', async () => {
				assert.equal(
					(await findPropertyForStaff(db, staffLimited, ids.propertyA1.propertyId)).id,
					ids.propertyA1.propertyId
				);
				await expectNotFound(() =>
					findPropertyForStaff(db, staffLimited, ids.propertyA2.propertyId)
				);
				await expectNotFound(() =>
					findPropertyForStaff(db, staffLimited, ids.propertyB1.propertyId)
				);

				assert.equal(
					(await findManagedTenantForStaff(db, staffLimited, ext.managedTenantANow)).id,
					ext.managedTenantANow
				);
				await expectNotFound(() =>
					findManagedTenantForStaff(db, staffEmpty, ext.managedTenantANow)
				);
			});

			await t.test('matrix: tenant meter history and payment account via invoice', async () => {
				const meter = await findMeterReadingForTenantHistory(
					db,
					tenantANow,
					historyNow,
					ids.meterReadingANow.meterReadingId
				);
				assert.equal(meter.id, ids.meterReadingANow.meterReadingId);
				await expectNotFound(() =>
					findMeterReadingForTenantHistory(
						db,
						tenantANow,
						historyNow,
						ids.meterReadingAOld.meterReadingId
					)
				);
				await expectNotFound(() =>
					findMeterReadingForTenantHistory(
						db,
						tenantAOld,
						historyNow,
						ids.meterReadingANow.meterReadingId
					)
				);

				const pay = await findPaymentAccountForTenantHistory(
					db,
					tenantANow,
					historyNow,
					ids.invoiceANow.invoiceId
				);
				assert.equal(pay.id, ids.paymentAccountA.paymentAccountId);
				assert.equal('payosApiKeyEnc' in pay, false);
				assert.equal('payosChecksumKeyEnc' in pay, false);

				await expectNotFound(() =>
					findPaymentAccountForTenantHistory(db, tenantANow, historyNow, ids.invoiceBNow.invoiceId)
				);
				await expectNotFound(() =>
					findPaymentAccountForTenantHistory(db, tenantAOld, historyNow, ids.invoiceANow.invoiceId)
				);

				// Invoice A intentionally points at landlord B payment account → 404
				await handle.db
					.update(invoices)
					.set({ paymentAccountId: ids.paymentAccountB.paymentAccountId })
					.where(eq(invoices.id, ids.invoiceANow.invoiceId));
				await expectNotFound(() =>
					findPaymentAccountForTenantHistory(db, tenantANow, historyNow, ids.invoiceANow.invoiceId)
				);
				await handle.db
					.update(invoices)
					.set({ paymentAccountId: ids.paymentAccountA.paymentAccountId })
					.where(eq(invoices.id, ids.invoiceANow.invoiceId));
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
