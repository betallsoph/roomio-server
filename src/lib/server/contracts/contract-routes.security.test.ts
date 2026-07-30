import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { LandlordActor, TenantActor } from '../authorization/actor.js';
import { createDrizzleActorDb, getUserActor } from '../authorization/load-user-actor.js';
import {
	expectForeignResourceHidden,
	expectNoForbiddenKeys
} from '../authorization/security-assertions.js';
import { contracts, managedTenants, tenancies } from '../db/schema.js';
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

type ContractRouteExtensions = {
	managedTenantANow: string;
	managedTenantAOld: string;
	tenancyANowActive: string;
	tenancyAOldEnded: string;
};

async function seedContractRouteExtensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<ContractRouteExtensions> {
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

	await db
		.update(contracts)
		.set({ managedTenantId: managedTenantAOld, tenancyId: tenancyAOldEnded })
		.where(eq(contracts.id, ids.contractAOld.contractId));
	await db
		.update(contracts)
		.set({ managedTenantId: managedTenantANow, tenancyId: tenancyANowActive })
		.where(eq(contracts.id, ids.contractANow.contractId));

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

function tenantActor(fixture: SecurityFixtureMap, which: 'tenantANow' | 'tenantAOld'): TenantActor {
	const row = fixture.ids[which];
	return {
		kind: 'USER',
		userId: row.userId,
		role: 'TENANT',
		tenantProfileId: row.tenantProfileId
	};
}

const contractIds = (body: unknown): string[] =>
	Array.isArray(body) ? body.map((row) => (row as { id: string }).id) : [];

if (skipReason) {
	test('AUTH-012 contract route security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-012 contract route authorization', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			await seedContractRouteExtensions(handle, fixture);
			const { ids } = fixture;
			const { GET, PUT, DELETE } = await import('../../../routes/api/contracts/+server.js');
			const actorDb = createDrizzleActorDb(handle.db);

			const landlordA = landlordActor(fixture, 'landlordA');
			const landlordB = landlordActor(fixture, 'landlordB');
			const tenantANow = tenantActor(fixture, 'tenantANow');
			const tenantAOld = tenantActor(fixture, 'tenantAOld');

			async function listContracts(
				actor: LandlordActor | TenantActor,
				params: Record<string, string> = {}
			) {
				const qs = new URLSearchParams(params).toString();
				const url = new URL(`http://localhost/api/contracts${qs ? '?' + qs : ''}`);
				const res = await callHandler(GET, { url, locals: { actor, requestId: 'req-auth012' } });
				return readJson(res);
			}

			await t.test('unauthenticated GET returns 401', async () => {
				const url = new URL('http://localhost/api/contracts');
				const res = await callHandler(GET, { url, locals: { actor: null, requestId: 'req' } });
				assert.equal((await readJson(res)).status, 401);
			});

			await t.test('landlordA list excludes landlordB contracts', async () => {
				const result = await listContracts(landlordA);
				assert.equal(result.status, 200);
				const listed = contractIds(result.body);
				assert.ok(listed.includes(ids.contractANow.contractId));
				assert.ok(!listed.includes(ids.contractBNow.contractId));
				expectNoForbiddenKeys(result.body);
			});

			await t.test('landlordA ignores foreign landlordId query param', async () => {
				const result = await listContracts(landlordA, {
					landlordId: ids.landlordB.landlordProfileId
				});
				assert.equal(result.status, 200);
				const listed = contractIds(result.body);
				assert.ok(listed.includes(ids.contractANow.contractId));
				assert.ok(!listed.includes(ids.contractBNow.contractId));
			});

			await t.test('tenantANow sees only current tenancy snapshot contracts', async () => {
				const result = await listContracts(tenantANow);
				assert.equal(result.status, 200);
				const listed = contractIds(result.body);
				assert.ok(listed.includes(ids.contractANow.contractId));
				assert.ok(!listed.includes(ids.contractAOld.contractId));
				assert.ok(!listed.includes(ids.contractBNow.contractId));
				expectNoForbiddenKeys(result.body);
			});

			await t.test(
				'tenantAOld sees predecessor contract but not successor on same room',
				async () => {
					const result = await listContracts(tenantAOld);
					assert.equal(result.status, 200);
					const listed = contractIds(result.body);
					assert.ok(listed.includes(ids.contractAOld.contractId));
					assert.ok(!listed.includes(ids.contractANow.contractId));
				}
			);

			await t.test('landlordB PUT on landlordA contract returns 404', async () => {
				const res = await callHandler(PUT, {
					request: new Request('http://localhost/api/contracts', {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ id: ids.contractANow.contractId, notes: 'cross-scope' })
					}),
					locals: { actor: landlordB, requestId: 'req' }
				});
				await expectForeignResourceHidden(res, {
					sensitiveIds: [ids.contractANow.contractId]
				});
			});

			await t.test('landlordB DELETE on landlordA contract returns 404', async () => {
				const url = new URL(`http://localhost/api/contracts?id=${ids.contractANow.contractId}`);
				const res = await callHandler(DELETE, {
					url,
					locals: { actor: landlordB, requestId: 'req' }
				});
				await expectForeignResourceHidden(res, {
					sensitiveIds: [ids.contractANow.contractId]
				});
			});

			await t.test('staff cannot list contracts', async () => {
				const staff = await getUserActor(fixtureSession(fixture, 'staffALimited'), actorDb);
				const url = new URL('http://localhost/api/contracts');
				const res = await callHandler(GET, {
					url,
					locals: { actor: staff, requestId: 'req' }
				});
				assert.equal((await readJson(res)).status, 403);
			});
		});
	});
}
