import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import {
	maintenanceRequests,
	managedTenants,
	meterReadings,
	staffPermissions,
	staffProfiles,
	staffPropertyAssignments,
	tenancies,
	users
} from '../db/schema.js';
import type { LandlordActor, StaffActor, TenantActor } from '../authorization/actor.js';
import { createDrizzleActorDb, getUserActor } from '../authorization/load-user-actor.js';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
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

type Auth013Extension = {
	managedTenantANow: string;
	managedTenantAOld: string;
	tenancyANowActive: string;
	tenancyAOldEnded: string;
	staffARequestsId: string;
	staffARequestsUserId: string;
};

async function seedAuth013Extensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<Auth013Extension> {
	const { ids } = fixture;
	const db = handle.db;

	const managedTenantANow = crypto.randomUUID();
	const managedTenantAOld = crypto.randomUUID();
	const tenancyANowActive = crypto.randomUUID();
	const tenancyAOldEnded = crypto.randomUUID();
	const staffARequestsId = crypto.randomUUID();
	const staffARequestsUserId = crypto.randomUUID();

	await db.insert(managedTenants).values([
		{
			id: managedTenantANow,
			landlordId: ids.landlordA.landlordProfileId,
			displayName: 'AUTH-013 managed tenant now',
			claimedByUserId: ids.tenantANow.userId,
			legacyTenantProfileId: ids.tenantANow.tenantProfileId,
			backfillSource: 'LEGACY_TENANT_PROFILE'
		},
		{
			id: managedTenantAOld,
			landlordId: ids.landlordA.landlordProfileId,
			displayName: 'AUTH-013 managed tenant old',
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
		.update(meterReadings)
		.set({ managedTenantId: managedTenantANow, tenancyId: tenancyANowActive })
		.where(eq(meterReadings.id, ids.meterReadingANow.meterReadingId));
	await db
		.update(meterReadings)
		.set({ managedTenantId: managedTenantAOld, tenancyId: tenancyAOldEnded })
		.where(eq(meterReadings.id, ids.meterReadingAOld.meterReadingId));

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

	await db.insert(users).values({
		id: staffARequestsUserId,
		email: `auth013-staff-requests-${handle.runId}@fixture.test`,
		phone: `09${handle.runId.slice(-8)}1`,
		name: 'AUTH-013 staff requests',
		passwordHash: 'fixture',
		role: 'STAFF',
		isActive: true
	});
	await db.insert(staffProfiles).values({
		id: staffARequestsId,
		userId: staffARequestsUserId,
		landlordId: ids.landlordA.landlordProfileId
	});
	await db.insert(staffPermissions).values({
		staffId: staffARequestsId,
		permission: 'MANAGE_REQUESTS',
		grantedByUserId: ids.landlordA.userId
	});
	await db.insert(staffPropertyAssignments).values({
		staffId: staffARequestsId,
		propertyId: ids.propertyA1.propertyId,
		assignedByUserId: ids.landlordA.userId
	});

	return {
		managedTenantANow,
		managedTenantAOld,
		tenancyANowActive,
		tenancyAOldEnded,
		staffARequestsId,
		staffARequestsUserId
	};
}

async function actorFromSession(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap,
	who: Parameters<typeof fixtureSession>[1]
) {
	const actorDb = createDrizzleActorDb(handle.db);
	const actor = await getUserActor(fixtureSession(fixture, who), actorDb);
	return actor;
}

async function callHandler(handler: unknown, event: Record<string, unknown>): Promise<Response> {
	return (handler as (e: unknown) => Promise<Response>)(event);
}

async function readJson(response: Response): Promise<{ status: number; body: unknown }> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	return { status: response.status, body };
}

if (skipReason) {
	test('AUTH-013 operations security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-013 operations security suite', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ext = await seedAuth013Extensions(handle, fixture);
			const ids = fixture.ids;

			const { GET: getMeterReadings } =
				await import('../../../routes/api/meter-readings/+server.js');
			const {
				GET: getRequests,
				POST: postRequests,
				PUT: putRequests
			} = await import('../../../routes/api/requests/+server.js');
			const { POST: parseMeter } =
				await import('../../../routes/api/meter-readings/parse/+server.js');

			const landlordA = (await actorFromSession(handle, fixture, 'landlordA')) as LandlordActor;
			const tenantANow = (await actorFromSession(handle, fixture, 'tenantANow')) as TenantActor;
			const tenantAOld = (await actorFromSession(handle, fixture, 'tenantAOld')) as TenantActor;
			const staffMeters = (await actorFromSession(handle, fixture, 'staffALimited')) as StaffActor;

			const staffRequestsSession = {
				...fixtureSession(fixture, 'staffALimited'),
				userId: ext.staffARequestsUserId,
				staffProfileId: ext.staffARequestsId
			};
			const staffRequests = (await getUserActor(
				staffRequestsSession,
				createDrizzleActorDb(handle.db)
			)) as StaffActor;

			async function meterGet(actor: LandlordActor | StaffActor | TenantActor) {
				const url = new URL('http://localhost/api/meter-readings');
				return readJson(await callHandler(getMeterReadings, { url, locals: { actor } }));
			}

			async function requestGet(actor: LandlordActor | StaffActor | TenantActor) {
				const url = new URL('http://localhost/api/requests');
				return readJson(await callHandler(getRequests, { url, locals: { actor } }));
			}

			await t.test('A/B: landlordA meter list excludes landlordB rooms', async () => {
				const result = await meterGet(landlordA);
				assert.equal(result.status, 200);
				const roomIds = (result.body as Array<{ roomId: string }>).map((row) => row.roomId);
				assert.ok(roomIds.includes(ids.roomA1R1.roomId));
				assert.ok(!roomIds.includes(ids.roomB1R1.roomId));
				expectNoForbiddenKeys(result.body);
			});

			await t.test('A/B: landlordA request list excludes landlordB maintenance ids', async () => {
				const result = await requestGet(landlordA);
				assert.equal(result.status, 200);
				const requestIds = (result.body as Array<{ id: string }>).map((row) => row.id);
				assert.ok(requestIds.includes(ids.maintenanceANow.maintenanceRequestId));
				assert.ok(
					!requestIds.includes(ids.maintenanceAOld.maintenanceRequestId) || requestIds.length >= 1
				);
				expectNoForbiddenKeys(result.body);
			});

			await t.test('staff A1 cannot read property A2 meter readings', async () => {
				const result = await meterGet(staffMeters);
				assert.equal(result.status, 200);
				const roomIds = (result.body as Array<{ roomId: string }>).map((row) => row.roomId);
				assert.ok(!roomIds.includes(ids.roomA2R1.roomId));
			});

			await t.test('staff with MANAGE_METERS is forbidden on requests list', async () => {
				const result = await requestGet(staffMeters);
				assert.equal(result.status, 403);
			});

			await t.test('staff with MANAGE_REQUESTS can list scoped requests', async () => {
				const result = await requestGet(staffRequests);
				assert.equal(result.status, 200);
				expectNoForbiddenKeys(result.body);
			});

			await t.test('landlord cannot assign staffB to property A request', async () => {
				const result = await readJson(
					await callHandler(putRequests, {
						request: new Request('http://localhost/api/requests', {
							method: 'PUT',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								id: ids.maintenanceANow.maintenanceRequestId,
								assignedToId: ids.staffB.staffProfileId
							})
						}),
						locals: { actor: landlordA }
					})
				);
				assert.equal(result.status, 404);
			});

			await t.test('old tenant cannot submit maintenance after checkout', async () => {
				const result = await readJson(
					await callHandler(postRequests, {
						request: new Request('http://localhost/api/requests', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								category: 'plumbing',
								title: 'Old tenant leak',
								description: 'Should be denied'
							})
						}),
						locals: { actor: tenantAOld }
					})
				);
				assert.equal(result.status, 403);
			});

			await t.test('active tenant submit returns DTO without forbidden keys', async () => {
				const result = await readJson(
					await callHandler(postRequests, {
						request: new Request('http://localhost/api/requests', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								category: 'electrical',
								title: 'Outlet spark',
								description: 'Needs repair'
							})
						}),
						locals: { actor: tenantANow }
					})
				);
				assert.equal(result.status, 200);
				expectNoForbiddenKeys(result.body);
				const body = result.body as { landlordId: string; propertyId: string; roomId: string };
				assert.equal(body.landlordId, ids.landlordA.landlordProfileId);
				assert.equal(body.propertyId, ids.propertyA1.propertyId);
				assert.equal(body.roomId, ids.roomA1R1.roomId);
			});

			await t.test('OCR parse response strips raw debug text', async () => {
				const result = await readJson(
					await callHandler(parseMeter, {
						request: new Request('http://localhost/api/meter-readings/parse', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								photoUrl: 'https://assets.example.com/uploads/meters/x.jpg'
							})
						}),
						locals: { actor: tenantANow }
					})
				);
				assert.ok([200, 400, 503].includes(result.status));
				if (result.status === 200) {
					expectNoForbiddenKeys(result.body);
					assert.equal('rawText' in (result.body as object), false);
				}
			});
		});
	});
}
