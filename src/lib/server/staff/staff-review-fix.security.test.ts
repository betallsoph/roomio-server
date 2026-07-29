import assert from 'node:assert/strict';
import test from 'node:test';
import type { LandlordActor, SuperAdminActor, TenantActor } from '$lib/server/authorization/actor';
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
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { staffPermissions, staffProfiles, staffPropertyAssignments, users } from '../db/schema.js';
import { createDrizzleActorDb, getUserActor } from '../authorization/load-user-actor.js';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { deactivateStaff } from './lifecycle.js';
import { assignStaffProperty } from './assignments.js';

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

function superAdminActor(fixture: SecurityFixtureMap): SuperAdminActor {
	return {
		kind: 'USER',
		userId: fixture.ids.superAdmin.userId,
		role: 'SUPER_ADMIN'
	};
}

function tenantActor(fixture: SecurityFixtureMap): TenantActor {
	return {
		kind: 'USER',
		userId: fixture.ids.tenantANow.userId,
		role: 'TENANT',
		tenantProfileId: fixture.ids.tenantANow.tenantProfileId
	};
}

test('review-fix unit: SuperAdmin/Tenant/null-actor cannot list staff via handler', async () => {
	const { GET } = await import('../../../routes/api/staff/+server.js');

	const fakeLandlordCookie = {
		userId: 'cookie-landlord',
		role: 'LANDLORD' as const,
		landlordProfileId: 'cookie-landlord-id',
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null,
		enabledRentalTypes: null
	};

	const nullActor = await callHandler(GET, {
		url: new URL('http://localhost/api/staff'),
		locals: { session: fakeLandlordCookie, actor: null }
	});
	assert.equal((await readJson(nullActor)).status, 401);

	const superRes = await callHandler(GET, {
		url: new URL('http://localhost/api/staff'),
		locals: {
			session: fakeLandlordCookie,
			actor: { kind: 'USER', userId: 'sa', role: 'SUPER_ADMIN' }
		}
	});
	assert.equal((await readJson(superRes)).status, 403);

	const tenantRes = await callHandler(GET, {
		url: new URL('http://localhost/api/staff'),
		locals: {
			session: fakeLandlordCookie,
			actor: {
				kind: 'USER',
				userId: 't',
				role: 'TENANT',
				tenantProfileId: 'tp'
			}
		}
	});
	assert.equal((await readJson(tenantRes)).status, 403);
});

test('review-fix unit: SuperAdmin cannot POST staff create', async () => {
	const { POST } = await import('../../../routes/api/staff/+server.js');
	const res = await callHandler(POST, {
		request: new Request('http://localhost', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'x@test.com',
				phone: '0900000000',
				password: 'password-long',
				name: 'X'
			})
		}),
		locals: {
			session: null,
			actor: { kind: 'USER', userId: 'sa', role: 'SUPER_ADMIN' }
		}
	});
	assert.equal((await readJson(res)).status, 403);
});

if (skipReason) {
	test('AUTH-005 review-fix integration suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-005 review-fix integration', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ids = fixture.ids;
			const actor = landlordActor(fixture);

			const {
				GET,
				DELETE: deleteStaff,
				PUT
			} = await import('../../../routes/api/staff/+server.js');
			const { POST: postAssignment, DELETE: deleteAssignment } =
				await import('../../../routes/api/staff/[id]/assignments/+server.js');

			await t.test('SuperAdmin cannot list staff', async () => {
				const res = await callHandler(GET, {
					url: new URL('http://localhost/api/staff'),
					locals: {
						session: fixtureSession(fixture, 'superAdmin'),
						actor: superAdminActor(fixture)
					}
				});
				assert.equal((await readJson(res)).status, 403);
			});

			await t.test('fake landlord cookie without actor is rejected', async () => {
				const res = await callHandler(GET, {
					url: new URL('http://localhost/api/staff'),
					locals: {
						session: {
							userId: ids.landlordA.userId,
							role: 'LANDLORD',
							landlordProfileId: ids.landlordA.landlordProfileId,
							tenantProfileId: null,
							staffProfileId: null,
							staffLandlordId: null,
							enabledRentalTypes: null
						},
						actor: null
					}
				});
				assert.equal((await readJson(res)).status, 401);
			});

			await t.test('cross-landlord assignment → 404', async () => {
				const res = await callHandler(postAssignment, {
					params: { id: ids.staffALimited.staffProfileId },
					request: new Request('http://localhost', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ propertyId: ids.propertyB1.propertyId })
					}),
					locals: { session: fixtureSession(fixture, 'landlordA'), actor }
				});
				const result = await readJson(res);
				assert.equal(result.status, 404);
				expectNoForbiddenKeys(result.body);
			});

			await t.test('assignment response DTO omits assignedByUserId', async () => {
				const res = await callHandler(postAssignment, {
					params: { id: ids.staffAEmpty.staffProfileId },
					request: new Request('http://localhost', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ propertyId: ids.propertyA2.propertyId })
					}),
					locals: { session: fixtureSession(fixture, 'landlordA'), actor }
				});
				const result = await readJson(res);
				assert.equal(result.status, 200);
				const body = result.body as { assignment: Record<string, unknown>; changed: boolean };
				assert.equal(body.changed, true);
				assert.equal('assignedByUserId' in body.assignment, false);
				assert.ok(body.assignment.id);
				assert.equal(body.assignment.propertyId, ids.propertyA2.propertyId);
			});

			await t.test('delete/deactivate keeps history rows with revokedAt', async () => {
				const staffId = ids.staffALimited.staffProfileId;
				const beforeAssignments = await handle.db.query.staffPropertyAssignments.findMany({
					where: eq(staffPropertyAssignments.staffId, staffId)
				});
				assert.ok(beforeAssignments.length >= 1);

				const res = await callHandler(deleteStaff, {
					url: new URL(`http://localhost/api/staff?id=${staffId}`),
					locals: { session: fixtureSession(fixture, 'landlordA'), actor }
				});
				assert.equal((await readJson(res)).status, 200);

				const profile = await handle.db.query.staffProfiles.findFirst({
					where: eq(staffProfiles.id, staffId)
				});
				assert.ok(profile, 'StaffProfile must remain');

				const user = await handle.db.query.users.findFirst({
					where: eq(users.id, ids.staffALimited.userId)
				});
				assert.equal(user?.isActive, false);

				const history = await handle.db.query.staffPropertyAssignments.findMany({
					where: and(
						eq(staffPropertyAssignments.staffId, staffId),
						isNotNull(staffPropertyAssignments.revokedAt)
					)
				});
				assert.ok(history.length >= 1);

				const stillActive = await handle.db.query.staffPropertyAssignments.findMany({
					where: and(
						eq(staffPropertyAssignments.staffId, staffId),
						isNull(staffPropertyAssignments.revokedAt)
					)
				});
				assert.equal(stillActive.length, 0);

				const activePerms = await handle.db.query.staffPermissions.findMany({
					where: and(eq(staffPermissions.staffId, staffId), isNull(staffPermissions.revokedAt))
				});
				assert.equal(activePerms.length, 0);
			});

			await t.test('deactivated staff session fails getUserActor on next request', async () => {
				const actorDb = createDrizzleActorDb(handle.db);
				await assert.rejects(
					() => getUserActor(fixtureSession(fixture, 'staffALimited'), actorDb),
					(err: unknown) =>
						err instanceof Error && 'status' in err && (err as { status: number }).status === 401
				);
			});

			await t.test('PUT isActive=false uses deactivate path and keeps profile', async () => {
				const staffId = ids.staffAEmpty.staffProfileId;
				await assignStaffProperty(handle.db, actor, {
					staffId,
					propertyId: ids.propertyA1.propertyId
				});

				const res = await callHandler(PUT, {
					request: new Request('http://localhost', {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ id: staffId, isActive: false })
					}),
					locals: { session: fixtureSession(fixture, 'landlordA'), actor }
				});
				assert.equal((await readJson(res)).status, 200);

				const user = await handle.db.query.users.findFirst({
					where: eq(users.id, ids.staffAEmpty.userId)
				});
				assert.equal(user?.isActive, false);

				const active = await handle.db.query.staffPropertyAssignments.findMany({
					where: and(
						eq(staffPropertyAssignments.staffId, staffId),
						isNull(staffPropertyAssignments.revokedAt)
					)
				});
				assert.equal(active.length, 0);
			});

			await t.test('Tenant actor cannot manage assignments', async () => {
				const res = await callHandler(deleteAssignment, {
					params: { id: ids.staffB.staffProfileId },
					url: new URL(`http://localhost?propertyId=${ids.propertyB1.propertyId}`),
					locals: {
						session: fixtureSession(fixture, 'tenantANow'),
						actor: tenantActor(fixture)
					}
				});
				assert.equal((await readJson(res)).status, 403);
			});

			await t.test('service deactivateStaff is idempotent when already inactive', async () => {
				const first = await deactivateStaff(handle.db, actor, ids.staffALimited.staffProfileId);
				assert.equal(first.changed, false);
			});
		});
	});
}
