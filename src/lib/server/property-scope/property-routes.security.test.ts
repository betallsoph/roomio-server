import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { LandlordActor, StaffActor, TenantActor } from '../authorization/actor.js';
import { createDrizzleActorDb, getUserActor } from '../authorization/load-user-actor.js';
import {
	expectForeignResourceHidden,
	expectNoForbiddenKeys
} from '../authorization/security-assertions.js';
import { blocks, managedTenants, roomAssets, roomServiceConfigs, tenancies } from '../db/schema.js';
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

type PropertyRouteExtensions = {
	managedTenantANow: string;
	tenancyANowActive: string;
	roomAssetA1: string;
	blockA1: string;
};

async function seedPropertyRouteExtensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<PropertyRouteExtensions> {
	const { ids } = fixture;
	const db = handle.db;

	const managedTenantANow = crypto.randomUUID();
	const tenancyANowActive = crypto.randomUUID();
	const roomAssetA1 = crypto.randomUUID();
	const blockA1 = crypto.randomUUID();

	await db.insert(managedTenants).values({
		id: managedTenantANow,
		landlordId: ids.landlordA.landlordProfileId,
		displayName: 'Managed tenant A now',
		claimedByUserId: ids.tenantANow.userId,
		legacyTenantProfileId: ids.tenantANow.tenantProfileId,
		backfillSource: 'LEGACY_TENANT_PROFILE'
	});

	await db.insert(tenancies).values({
		id: tenancyANowActive,
		landlordId: ids.landlordA.landlordProfileId,
		propertyId: ids.propertyA1.propertyId,
		roomId: ids.roomA1R1.roomId,
		managedTenantId: managedTenantANow,
		status: 'ACTIVE',
		startDate: '2026-01-01',
		plannedEndDate: '2026-12-31'
	});

	await db.insert(blocks).values({
		id: blockA1,
		propertyId: ids.propertyA1.propertyId,
		name: 'Block fixture A1'
	});

	await db.insert(roomAssets).values({
		id: roomAssetA1,
		roomId: ids.roomA1R1.roomId,
		name: 'Fixture AC',
		status: 'good'
	});

	await db.insert(roomServiceConfigs).values({
		id: crypto.randomUUID(),
		roomId: ids.roomA1R1.roomId,
		serviceId: ids.serviceA.serviceId
	});

	return { managedTenantANow, tenancyANowActive, roomAssetA1, blockA1 };
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

function tenantActor(fixture: SecurityFixtureMap, which: 'tenantANow' | 'tenantBNow'): TenantActor {
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
	return actor as StaffActor;
}

if (skipReason) {
	test('AUTH-010 property-tree security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-010 property-tree route security', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ext = await seedPropertyRouteExtensions(handle, fixture);
			const ids = fixture.ids;

			const {
				GET: getProperties,
				PUT: putProperties,
				DELETE: deleteProperties
			} = await import('../../../routes/api/properties/+server.js');
			const {
				GET: getRooms,
				PUT: putRooms,
				DELETE: deleteRooms
			} = await import('../../../routes/api/rooms/+server.js');
			const { GET: getServices, PUT: putServices } =
				await import('../../../routes/api/services/+server.js');

			const landlordA = landlordActor(fixture, 'landlordA');
			const landlordB = landlordActor(fixture, 'landlordB');
			const tenantANow = tenantActor(fixture, 'tenantANow');
			const tenantBNow = tenantActor(fixture, 'tenantBNow');
			const staffLimited = await staffActorFromFixture(handle, fixture, 'staffALimited');

			await t.test(
				'landlord A list excludes landlord B properties and forbidden keys',
				async () => {
					const res = await callHandler(getProperties, {
						url: new URL('http://localhost/api/properties'),
						locals: { actor: landlordA }
					});
					const result = await readJson(res);
					assert.equal(result.status, 200);
					const propertyIds = (result.body as Array<{ id: string }>).map((row) => row.id);
					assert.ok(propertyIds.includes(ids.propertyA1.propertyId));
					assert.ok(!propertyIds.includes(ids.propertyB1.propertyId));
					expectNoForbiddenKeys(result.body);
				}
			);

			await t.test(
				'staff assigned property read succeeds; unassigned property filter → 404',
				async () => {
					const listRes = await callHandler(getProperties, {
						url: new URL('http://localhost/api/properties'),
						locals: { actor: staffLimited }
					});
					const list = await readJson(listRes);
					assert.equal(list.status, 200);
					const propertyIds = (list.body as Array<{ id: string }>).map((row) => row.id);
					assert.ok(propertyIds.includes(ids.propertyA1.propertyId));
					assert.ok(!propertyIds.includes(ids.propertyA2.propertyId));
					expectNoForbiddenKeys(list.body);

					const foreignRoomRes = await callHandler(getRooms, {
						url: new URL(`http://localhost/api/rooms?propertyId=${ids.propertyA2.propertyId}`),
						locals: { actor: staffLimited }
					});
					assert.equal(foreignRoomRes.status, 404);
				}
			);

			await t.test('tenant sees only active tenancy property/room snapshot', async () => {
				const props = await readJson(
					await callHandler(getProperties, {
						url: new URL('http://localhost/api/properties'),
						locals: { actor: tenantANow }
					})
				);
				assert.equal(props.status, 200);
				const propertyIds = (props.body as Array<{ id: string }>).map((row) => row.id);
				assert.deepEqual(propertyIds, [ids.propertyA1.propertyId]);
				expectNoForbiddenKeys(props.body);

				const rooms = await readJson(
					await callHandler(getRooms, {
						url: new URL('http://localhost/api/rooms'),
						locals: { actor: tenantANow }
					})
				);
				assert.equal(rooms.status, 200);
				const roomIds = (rooms.body as Array<{ id: string }>).map((row) => row.id);
				assert.deepEqual(roomIds, [ids.roomA1R1.roomId]);
				expectNoForbiddenKeys(rooms.body);

				const foreign = await callHandler(getRooms, {
					url: new URL(`http://localhost/api/rooms?propertyId=${ids.propertyB1.propertyId}`),
					locals: { actor: tenantANow }
				});
				assert.equal(foreign.status, 404);
			});

			await t.test('tenant B cannot read landlord A property tree', async () => {
				const res = await callHandler(getProperties, {
					url: new URL('http://localhost/api/properties'),
					locals: { actor: tenantBNow }
				});
				const result = await readJson(res);
				assert.equal(result.status, 200);
				assert.equal((result.body as unknown[]).length, 0);
			});

			await t.test('asset on room A cannot be mutated from room B → 404', async () => {
				const res = await callHandler(putRooms, {
					request: new Request('http://localhost/api/rooms', {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							id: ids.roomB1R1.roomId,
							action: 'updateAsset',
							assetId: ext.roomAssetA1,
							name: 'Hijacked'
						})
					}),
					locals: { actor: landlordA }
				});
				await expectForeignResourceHidden(res, {
					sensitiveIds: [ext.roomAssetA1],
					status: 404
				});
			});

			await t.test('room service config rejects cross-landlord service → 404', async () => {
				const res = await callHandler(putRooms, {
					request: new Request('http://localhost/api/rooms', {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							id: ids.roomA1R1.roomId,
							action: 'updateServiceConfig',
							configs: [{ serviceId: ids.serviceB.serviceId, quantity: 1 }]
						})
					}),
					locals: { actor: landlordA }
				});
				assert.equal(res.status, 404);
			});

			await t.test(
				'block from property A rejected on property B room create path → 404',
				async () => {
					const res = await callHandler(putRooms, {
						request: new Request('http://localhost/api/rooms', {
							method: 'PUT',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								id: ids.roomA2R1.roomId,
								blockId: ext.blockA1
							})
						}),
						locals: { actor: landlordA }
					});
					assert.equal(res.status, 404);
				}
			);

			await t.test('landlord B cannot mutate landlord A service → 404', async () => {
				const res = await callHandler(putServices, {
					request: new Request('http://localhost/api/services', {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ id: ids.serviceA.serviceId, name: 'Stolen' })
					}),
					locals: { actor: landlordB }
				});
				assert.equal(res.status, 404);
			});

			await t.test('landlord B cannot delete landlord A property → 404', async () => {
				const res = await callHandler(deleteProperties, {
					url: new URL(`http://localhost/api/properties?id=${ids.propertyA1.propertyId}`),
					locals: { actor: landlordB }
				});
				assert.equal(res.status, 404);
			});

			await t.test(
				'landlord B blocks-only PUT on landlord A property → 404, no block insert (B1)',
				async () => {
					const before = await handle.db
						.select({ id: blocks.id })
						.from(blocks)
						.where(eq(blocks.propertyId, ids.propertyA1.propertyId));

					const res = await callHandler(putProperties, {
						request: new Request('http://localhost/api/properties', {
							method: 'PUT',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								id: ids.propertyA1.propertyId,
								blocks: ['Injected Block B1']
							})
						}),
						locals: { actor: landlordB }
					});
					await expectForeignResourceHidden(res, {
						sensitiveIds: [ids.propertyA1.propertyId],
						status: 404
					});

					const after = await handle.db
						.select({ id: blocks.id })
						.from(blocks)
						.where(eq(blocks.propertyId, ids.propertyA1.propertyId));
					assert.equal(after.length, before.length);
				}
			);

			await t.test(
				'landlord B empty PUT on landlord A room → 404, no room DTO leak (B2)',
				async () => {
					const res = await callHandler(putRooms, {
						request: new Request('http://localhost/api/rooms', {
							method: 'PUT',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ id: ids.roomA1R1.roomId })
						}),
						locals: { actor: landlordB }
					});
					await expectForeignResourceHidden(res, {
						sensitiveIds: [ids.roomA1R1.roomId, 'A1-R1'],
						status: 404
					});
				}
			);

			await t.test(
				'landlord B updateServiceConfig without configs on landlord A room → 404 (B2)',
				async () => {
					const res = await callHandler(putRooms, {
						request: new Request('http://localhost/api/rooms', {
							method: 'PUT',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								id: ids.roomA1R1.roomId,
								action: 'updateServiceConfig'
							})
						}),
						locals: { actor: landlordB }
					});
					await expectForeignResourceHidden(res, {
						sensitiveIds: [ids.roomA1R1.roomId],
						status: 404
					});
				}
			);

			await t.test('services list scoped per actor with forbidden-key scan', async () => {
				for (const [label, actor] of [
					['landlordA', landlordA],
					['staffLimited', staffLimited],
					['tenantANow', tenantANow]
				] as const) {
					const res = await callHandler(getServices, {
						url: new URL('http://localhost/api/services'),
						locals: { actor }
					});
					const result = await readJson(res);
					assert.equal(result.status, 200, `${label} services GET`);
					const serviceIds = (result.body as Array<{ id: string }>).map((row) => row.id);
					assert.ok(serviceIds.includes(ids.serviceA.serviceId), label);
					assert.ok(!serviceIds.includes(ids.serviceB.serviceId), label);
					expectNoForbiddenKeys(result.body);
				}
			});

			await t.test('staff cannot mutate property tree', async () => {
				const res = await callHandler(deleteRooms, {
					url: new URL(`http://localhost/api/rooms?id=${ids.roomA1R1.roomId}`),
					locals: { actor: staffLimited }
				});
				assert.equal(res.status, 403);
			});
		});
	});
}
