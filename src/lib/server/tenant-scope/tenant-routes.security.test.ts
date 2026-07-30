import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import type { LandlordActor, StaffActor } from '../authorization/actor.js';
import { createDrizzleActorDb, getUserActor } from '../authorization/load-user-actor.js';
import {
	expectForeignResourceHidden,
	expectNoForbiddenKeys
} from '../authorization/security-assertions.js';
import { managedTenants, staffPermissions, tenancies } from '../db/schema.js';
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

type TenantRouteExtensions = {
	managedTenantANow: string;
	managedTenantAOld: string;
	tenancyANowActive: string;
	tenancyAOldEnded: string;
};

async function seedTenantRouteExtensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<TenantRouteExtensions> {
	const { ids } = fixture;
	const db = handle.db;

	const managedTenantANow = crypto.randomUUID();
	const managedTenantAOld = crypto.randomUUID();
	const tenancyANowActive = crypto.randomUUID();
	const tenancyAOldEnded = crypto.randomUUID();

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

	return { managedTenantANow, managedTenantAOld, tenancyANowActive, tenancyAOldEnded };
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

function landlordActor(fixture: SecurityFixtureMap): LandlordActor {
	const session = fixtureSession(fixture, 'landlordA');
	assert.equal(session.role, 'LANDLORD');
	assert.ok(session.landlordProfileId);
	return {
		kind: 'USER',
		userId: session.userId,
		role: 'LANDLORD',
		landlordId: session.landlordProfileId
	};
}

function staffActor(
	fixture: SecurityFixtureMap,
	which: 'staffALimited' | 'staffAEmpty'
): StaffActor {
	const session = fixtureSession(fixture, which);
	assert.equal(session.role, 'STAFF');
	assert.ok(session.staffProfileId && session.staffLandlordId);
	return {
		kind: 'USER',
		userId: session.userId,
		role: 'STAFF',
		staffId: session.staffProfileId,
		landlordId: session.staffLandlordId,
		propertyIds: which === 'staffALimited' ? [fixture.ids.propertyA1.propertyId] : [],
		permissions: which === 'staffALimited' ? ['VIEW_ROOMS', 'MANAGE_METERS'] : []
	};
}

if (skipReason) {
	test('AUTH-011 tenant route security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-011 tenant and file route authorization', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ext = await seedTenantRouteExtensions(handle, fixture);
			const { GET: listTenants } = await import('../../../routes/api/tenants/+server.js');
			const { GET: getTenant } = await import('../../../routes/api/tenants/[tenantId]/+server.js');
			const { GET: getFile } = await import('../../../routes/api/files/[name]/+server.js');
			const { POST: presign } = await import('../../../routes/api/uploads/presign/+server.js');
			const { GET: listStaff } = await import('../../../routes/api/staff/+server.js');

			const landlordLocals = {
				session: fixtureSession(fixture, 'landlordA'),
				actor: landlordActor(fixture),
				requestId: 'req-auth011'
			};

			await t.test('landlord lists managed tenants with landlord DTO fields', async () => {
				const res = await callHandler(listTenants, { locals: landlordLocals });
				const result = await readJson(res);
				assert.equal(result.status, 200);
				assert.ok(Array.isArray(result.body));
				const rows = result.body as Array<Record<string, unknown>>;
				const now = rows.find((row) => row.id === ext.managedTenantANow);
				assert.ok(now);
				assert.equal(now?.emailSnapshot != null || now?.emailSnapshot === null, true);
				expectNoForbiddenKeys(result.body);
			});

			await t.test('staff without VIEW_TENANTS cannot list tenants', async () => {
				const actorDb = createDrizzleActorDb(handle.db);
				const staff = await getUserActor(fixtureSession(fixture, 'staffALimited'), actorDb);
				const res = await callHandler(listTenants, {
					locals: {
						session: fixtureSession(fixture, 'staffALimited'),
						actor: staff,
						requestId: 'req'
					}
				});
				assert.equal((await readJson(res)).status, 403);
			});

			await t.test(
				'staff with VIEW_TENANTS sees active tenant only, not ended history',
				async () => {
					await handle.db.insert(staffPermissions).values({
						id: crypto.randomUUID(),
						staffId: fixture.ids.staffALimited.staffProfileId,
						permission: 'VIEW_TENANTS',
						grantedByUserId: fixture.ids.landlordA.userId
					});

					const actorDb = createDrizzleActorDb(handle.db);
					const staff = await getUserActor(fixtureSession(fixture, 'staffALimited'), actorDb);
					const res = await callHandler(listTenants, {
						locals: {
							session: fixtureSession(fixture, 'staffALimited'),
							actor: staff,
							requestId: 'req'
						}
					});
					const result = await readJson(res);
					assert.equal(result.status, 200);
					const rows = result.body as Array<{ id: string; emailSnapshot?: unknown }>;
					const ids = rows.map((row) => row.id);
					assert.ok(ids.includes(ext.managedTenantANow));
					assert.equal(ids.includes(ext.managedTenantAOld), false);
					for (const row of rows) {
						assert.equal('emailSnapshot' in row, false);
					}
					expectNoForbiddenKeys(result.body);
				}
			);

			await t.test('tenant self list returns claimed managed tenants only', async () => {
				const actorDb = createDrizzleActorDb(handle.db);
				const tenant = await getUserActor(fixtureSession(fixture, 'tenantANow'), actorDb);
				const res = await callHandler(listTenants, {
					locals: {
						session: fixtureSession(fixture, 'tenantANow'),
						actor: tenant,
						requestId: 'req'
					}
				});
				const result = await readJson(res);
				assert.equal(result.status, 200);
				const body = result.body as { managedTenants: Array<{ id: string }> };
				assert.ok(body.managedTenants.some((row) => row.id === ext.managedTenantANow));
				expectNoForbiddenKeys(result.body);
			});

			await t.test('foreign managed tenant detail is hidden', async () => {
				const actorDb = createDrizzleActorDb(handle.db);
				const tenantB = await getUserActor(fixtureSession(fixture, 'tenantBNow'), actorDb);
				const res = await callHandler(getTenant, {
					params: { tenantId: ext.managedTenantANow },
					locals: {
						session: fixtureSession(fixture, 'tenantBNow'),
						actor: tenantB,
						requestId: 'req'
					}
				});
				await expectForeignResourceHidden(res);
			});

			await t.test('file download by name alone is denied without metadata', async () => {
				const res = await callHandler(getFile, {
					params: { name: `${crypto.randomUUID()}.jpg` },
					locals: landlordLocals
				});
				const result = await readJson(res);
				assert.equal(result.status, 403);
			});

			await t.test('file path traversal is rejected', async () => {
				const res = await callHandler(getFile, {
					params: { name: '../etc/passwd' },
					locals: landlordLocals
				});
				assert.equal(res.status, 400);
			});

			await t.test('presign without resource context is denied', async () => {
				const res = await callHandler(presign, {
					request: new Request('http://localhost', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							purpose: 'tenant-document',
							contentType: 'image/jpeg',
							byteSize: 1024
						})
					}),
					locals: landlordLocals
				});
				assert.equal((await readJson(res)).status, 403);
			});

			await t.test('presign foreign managed tenant is denied', async () => {
				const actorDb = createDrizzleActorDb(handle.db);
				const landlordB = await getUserActor(fixtureSession(fixture, 'landlordB'), actorDb);
				const res = await callHandler(presign, {
					request: new Request('http://localhost', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							purpose: 'tenant-document',
							contentType: 'image/jpeg',
							byteSize: 1024,
							resourceType: 'managedTenant',
							resourceId: ext.managedTenantANow
						})
					}),
					locals: {
						session: fixtureSession(fixture, 'landlordB'),
						actor: landlordB,
						requestId: 'req'
					}
				});
				assert.equal((await readJson(res)).status, 403);
			});

			await t.test('staff self-read returns own permission summary only', async () => {
				const actorDb = createDrizzleActorDb(handle.db);
				const staff = await getUserActor(fixtureSession(fixture, 'staffALimited'), actorDb);
				const res = await callHandler(listStaff, {
					url: new URL('http://localhost/api/staff'),
					locals: {
						session: fixtureSession(fixture, 'staffALimited'),
						actor: staff,
						requestId: 'req'
					}
				});
				const result = await readJson(res);
				assert.equal(result.status, 200);
				const body = result.body as { id: string; permissions: string[]; propertyIds: string[] };
				assert.equal(body.id, fixture.ids.staffALimited.staffProfileId);
				assert.ok(body.permissions.includes('VIEW_TENANTS'));
				expectNoForbiddenKeys(result.body);
			});

			await t.test('staff cannot list all staff profiles', async () => {
				const actor = staffActor(fixture, 'staffALimited');
				const res = await callHandler(listStaff, {
					url: new URL('http://localhost/api/staff'),
					locals: {
						session: fixtureSession(fixture, 'staffALimited'),
						actor,
						requestId: 'req'
					}
				});
				const result = await readJson(res);
				assert.equal(result.status, 200);
				assert.equal((result.body as { id: string }).id, fixture.ids.staffALimited.staffProfileId);
				assert.equal(Array.isArray(result.body), false);
			});
		});
	});
}
