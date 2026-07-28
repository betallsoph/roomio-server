import assert from 'node:assert/strict';
import test from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';
import {
	fixtureSession,
	seedSecurityFixturesFromHandle,
	type SecurityFixtureMap
} from '../testing/security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb
} from '../testing/test-db.js';
import { staffPropertyAssignments } from '../db/schema.js';
import { listStaffAssignmentsPermissions } from '../staff/assignments.js';
import { createDrizzleActorDb, getUserActor } from './load-user-actor.js';
import { expectNoForbiddenKeys } from './security-assertions.js';

const skipReason = getSecurityIntegrationSkipReason();

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
	test('AUTH-005 staff assignment security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-005 staff assignment and permission isolation', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture: SecurityFixtureMap = await seedSecurityFixturesFromHandle(handle);
			const ids = fixture.ids;

			const { POST: postAssignment, DELETE: deleteAssignment } =
				await import('../../../routes/api/staff/[id]/assignments/+server.js');
			const { POST: postPermission, PUT: putPermissions } =
				await import('../../../routes/api/staff/[id]/permissions/+server.js');

			const landlordA = fixtureSession(fixture, 'landlordA');

			await t.test('landlord A cannot assign staffA into property B → 404', async () => {
				const res = await callHandler(postAssignment, {
					params: { id: ids.staffALimited.staffProfileId },
					request: new Request('http://localhost', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							propertyId: ids.propertyB1.propertyId,
							landlordId: ids.landlordB.landlordProfileId
						})
					}),
					locals: { session: landlordA, actor: null }
				});
				const result = await readJson(res);
				assert.equal(result.status, 404);
				expectNoForbiddenKeys(result.body);
			});

			await t.test('landlord A cannot grant permission to staffB → 404', async () => {
				const res = await callHandler(postPermission, {
					params: { id: ids.staffB.staffProfileId },
					request: new Request('http://localhost', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ permission: 'VIEW_ROOMS' })
					}),
					locals: { session: landlordA, actor: null }
				});
				const result = await readJson(res);
				assert.equal(result.status, 404);
			});

			await t.test('unknown permission → 422', async () => {
				const res = await callHandler(postPermission, {
					params: { id: ids.staffAEmpty.staffProfileId },
					request: new Request('http://localhost', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ permission: 'NOT_A_CAPABILITY' })
					}),
					locals: { session: landlordA, actor: null }
				});
				assert.equal((await readJson(res)).status, 422);
			});

			await t.test('wildcard permission in allowlist replace → 422', async () => {
				const res = await callHandler(putPermissions, {
					params: { id: ids.staffAEmpty.staffProfileId },
					request: new Request('http://localhost', {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ permissions: ['*'] })
					}),
					locals: { session: landlordA, actor: null }
				});
				assert.equal((await readJson(res)).status, 422);
			});

			await t.test('staff with no assignment → propertyIds []', async () => {
				const snapshot = await listStaffAssignmentsPermissions(
					ids.staffAEmpty.staffProfileId,
					ids.landlordA.landlordProfileId,
					handle.db
				);
				assert.deepEqual(snapshot.propertyIds, []);
			});

			await t.test('duplicate active assignment is idempotent with single active row', async () => {
				const staffId = ids.staffAEmpty.staffProfileId;
				const propertyId = ids.propertyA1.propertyId;
				const body = JSON.stringify({ propertyId, landlordId: ids.landlordB.landlordProfileId });

				const first = await readJson(
					await callHandler(postAssignment, {
						params: { id: staffId },
						request: new Request('http://localhost', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body
						}),
						locals: { session: landlordA, actor: null }
					})
				);
				assert.equal(first.status, 200);
				const firstBody = first.body as { changed?: boolean };
				assert.equal(firstBody.changed, true);

				const second = await readJson(
					await callHandler(postAssignment, {
						params: { id: staffId },
						request: new Request('http://localhost', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body
						}),
						locals: { session: landlordA, actor: null }
					})
				);
				assert.equal(second.status, 200);
				const secondBody = second.body as { changed?: boolean };
				assert.equal(secondBody.changed, false);

				const active = await handle.db.query.staffPropertyAssignments.findMany({
					where: and(
						eq(staffPropertyAssignments.staffId, staffId),
						eq(staffPropertyAssignments.propertyId, propertyId),
						isNull(staffPropertyAssignments.revokedAt)
					)
				});
				assert.equal(active.length, 1);
			});

			await t.test('revoke then subsequent loads see empty propertyIds', async () => {
				const staffId = ids.staffALimited.staffProfileId;
				const propertyId = ids.propertyA1.propertyId;
				const landlordId = ids.landlordA.landlordProfileId;

				const before = await listStaffAssignmentsPermissions(staffId, landlordId, handle.db);
				assert.deepEqual(before.propertyIds, [propertyId]);

				const delRes = await callHandler(deleteAssignment, {
					params: { id: staffId },
					url: new URL(`http://localhost?propertyId=${propertyId}`),
					locals: { session: landlordA, actor: null }
				});
				assert.equal((await readJson(delRes)).status, 200);

				const afterFirst = await listStaffAssignmentsPermissions(staffId, landlordId, handle.db);
				const afterSecond = await listStaffAssignmentsPermissions(staffId, landlordId, handle.db);
				assert.deepEqual(afterFirst.propertyIds, []);
				assert.deepEqual(afterSecond.propertyIds, []);
			});

			await t.test(
				'getUserActor loads empty scope for staffAEmpty and A1 scope for staffALimited',
				async () => {
					const actorDb = createDrizzleActorDb(handle.db);
					const empty = await getUserActor(fixtureSession(fixture, 'staffAEmpty'), actorDb);
					assert.equal(empty.role, 'STAFF');
					if (empty.role !== 'STAFF') return;
					assert.deepEqual(empty.propertyIds, []);
					assert.deepEqual(empty.permissions, []);

					const limited = await getUserActor(fixtureSession(fixture, 'staffALimited'), actorDb);
					assert.equal(limited.role, 'STAFF');
					if (limited.role !== 'STAFF') return;
					assert.deepEqual(limited.propertyIds, [ids.propertyA1.propertyId]);
					assert.deepEqual(limited.permissions, ['VIEW_ROOMS', 'MANAGE_METERS']);

					const afterAgain = await getUserActor(fixtureSession(fixture, 'staffAEmpty'), actorDb);
					assert.equal(afterAgain.role, 'STAFF');
					if (afterAgain.role !== 'STAFF') return;
					assert.deepEqual(afterAgain.propertyIds, []);
				}
			);
		});
	});
}
