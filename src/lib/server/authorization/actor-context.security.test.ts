import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SessionData } from '../session.js';
import { users } from '../db/schema.js';
import { UnauthorizedError } from './errors.js';
import { createDrizzleActorDb, type ActorDb } from './load-user-actor.js';
import {
	fixtureSession,
	seedSecurityFixturesFromHandle,
	type SecurityFixtureActor,
	type SecurityFixtureMap
} from '../testing/security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb,
	type SecurityDbHandle
} from '../testing/test-db.js';

const skipReason = getSecurityIntegrationSkipReason();

function createActorDbFromHandle(handle: SecurityDbHandle): ActorDb {
	return createDrizzleActorDb(handle.db);
}

async function expectUnauthorized(run: () => Promise<unknown>): Promise<void> {
	await assert.rejects(run, (error: unknown) => {
		assert.ok(error instanceof UnauthorizedError);
		assert.equal(error.status, 401);
		return true;
	});
}

function envSuperAdminSession(): SessionData {
	return {
		userId: 'env-super-admin',
		role: 'SUPER_ADMIN',
		landlordProfileId: null,
		enabledRentalTypes: null,
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null
	};
}

function emptySessionBase(): Pick<SessionData, 'enabledRentalTypes'> {
	return {
		enabledRentalTypes: null
	};
}

async function insertUserWithoutProfile(
	handle: SecurityDbHandle,
	role: 'LANDLORD' | 'TENANT' | 'STAFF'
): Promise<{ userId: string }> {
	const userId = crypto.randomUUID();
	const tag = userId.slice(0, 8);
	await handle.db.insert(users).values({
		id: userId,
		email: `sec-orphan-${role.toLowerCase()}-${tag}@fixture.test`,
		phone: `091${tag.slice(0, 7)}`,
		passwordHash: 'security-fixture-test-hash',
		name: `Orphan ${role}`,
		role,
		isActive: true
	});
	return { userId };
}

type HappyActorCase = {
	actor: SecurityFixtureActor;
	assertActor: (
		actor: Awaited<ReturnType<typeof import('./load-user-actor.js').getUserActor>>,
		fixture: SecurityFixtureMap
	) => void;
};

const HAPPY_ACTOR_CASES: HappyActorCase[] = [
	{
		actor: 'landlordA',
		assertActor(actor, fixture) {
			assert.equal(actor.kind, 'USER');
			assert.equal(actor.role, 'LANDLORD');
			if (actor.role !== 'LANDLORD') return;
			assert.equal(actor.userId, fixture.ids.landlordA.userId);
			assert.equal(actor.landlordId, fixture.ids.landlordA.landlordProfileId);
		}
	},
	{
		actor: 'tenantANow',
		assertActor(actor, fixture) {
			assert.equal(actor.kind, 'USER');
			assert.equal(actor.role, 'TENANT');
			if (actor.role !== 'TENANT') return;
			assert.equal(actor.userId, fixture.ids.tenantANow.userId);
			assert.equal(actor.tenantProfileId, fixture.ids.tenantANow.tenantProfileId);
			assert.equal('landlordId' in actor, false);
		}
	},
	{
		actor: 'staffALimited',
		assertActor(actor, fixture) {
			assert.equal(actor.kind, 'USER');
			assert.equal(actor.role, 'STAFF');
			if (actor.role !== 'STAFF') return;
			assert.equal(actor.userId, fixture.ids.staffALimited.userId);
			assert.equal(actor.staffId, fixture.ids.staffALimited.staffProfileId);
			assert.equal(actor.landlordId, fixture.ids.staffALimited.staffLandlordId);
			assert.deepEqual(actor.propertyIds, [fixture.ids.propertyA1.propertyId]);
			assert.deepEqual(actor.permissions, ['VIEW_ROOMS', 'MANAGE_METERS']);
		}
	},
	{
		actor: 'superAdmin',
		assertActor(actor, fixture) {
			assert.equal(actor.kind, 'USER');
			assert.equal(actor.role, 'SUPER_ADMIN');
			if (actor.role !== 'SUPER_ADMIN') return;
			assert.equal(actor.userId, fixture.ids.superAdmin.userId);
			assert.equal('landlordId' in actor, false);
			assert.equal('tenantProfileId' in actor, false);
			assert.equal('staffId' in actor, false);
		}
	}
];

if (skipReason) {
	test('actor-context security integration suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('actor context security integration', async (t) => {
		const { getUserActor } = await import('./load-user-actor.js');

		for (const { actor, assertActor } of HAPPY_ACTOR_CASES) {
			await t.test(`active ${actor} → getUserActor returns correct kind/ids`, async () => {
				await withSecurityDb(async (handle) => {
					const fixture = await seedSecurityFixturesFromHandle(handle);
					const actorDb = createActorDbFromHandle(handle);
					const session = fixtureSession(fixture, actor);
					const loaded = await getUserActor(session, actorDb);
					assertActor(loaded, fixture);
				});
			});
		}

		await t.test(
			'disabled user is authorized on first load then Unauthorized on second request',
			async () => {
				await withSecurityDb(async (handle) => {
					const fixture = await seedSecurityFixturesFromHandle(handle);
					const actorDb = createActorDbFromHandle(handle);
					const session = fixtureSession(fixture, 'landlordA');
					const first = await getUserActor(session, actorDb);
					assert.equal(first.kind, 'USER');
					assert.equal(first.role, 'LANDLORD');
					if (first.role === 'LANDLORD') {
						assert.equal(first.userId, fixture.ids.landlordA.userId);
						assert.equal(first.landlordId, fixture.ids.landlordA.landlordProfileId);
					}

					await handle.db
						.update(users)
						.set({ isActive: false })
						.where(eq(users.id, fixture.ids.landlordA.userId));

					await expectUnauthorized(() => getUserActor(session, actorDb));
					await expectUnauthorized(() => getUserActor(session, actorDb));
				});
			}
		);

		await t.test('role changed in DB → Unauthorized (session revoke signal)', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const session = fixtureSession(fixture, 'landlordA');
				const first = await getUserActor(session, actorDb);
				assert.equal(first.role, 'LANDLORD');
				if (first.role === 'LANDLORD') {
					assert.equal(first.landlordId, fixture.ids.landlordA.landlordProfileId);
				}

				await handle.db
					.update(users)
					.set({ role: 'TENANT' })
					.where(eq(users.id, fixture.ids.landlordA.userId));

				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('missing user row → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const session: SessionData = {
					...emptySessionBase(),
					userId: crypto.randomUUID(),
					role: 'LANDLORD',
					landlordProfileId: crypto.randomUUID(),
					tenantProfileId: null,
					staffProfileId: null,
					staffLandlordId: null
				};
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('landlord missing profile row → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const { userId } = await insertUserWithoutProfile(handle, 'LANDLORD');
				const session: SessionData = {
					...emptySessionBase(),
					userId,
					role: 'LANDLORD',
					landlordProfileId: crypto.randomUUID(),
					tenantProfileId: null,
					staffProfileId: null,
					staffLandlordId: null
				};
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('tenant missing profile row → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const { userId } = await insertUserWithoutProfile(handle, 'TENANT');
				const session: SessionData = {
					...emptySessionBase(),
					userId,
					role: 'TENANT',
					landlordProfileId: null,
					tenantProfileId: crypto.randomUUID(),
					staffProfileId: null,
					staffLandlordId: null
				};
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('staff missing profile row → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const { userId } = await insertUserWithoutProfile(handle, 'STAFF');
				const session: SessionData = {
					...emptySessionBase(),
					userId,
					role: 'STAFF',
					landlordProfileId: null,
					tenantProfileId: null,
					staffProfileId: crypto.randomUUID(),
					staffLandlordId: crypto.randomUUID()
				};
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('staff session staffLandlordId cookie mismatch → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const session: SessionData = {
					...fixtureSession(fixture, 'staffALimited'),
					staffLandlordId: fixture.ids.landlordB.landlordProfileId
				};
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('staff session staffProfileId cookie mismatch → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const session: SessionData = {
					...fixtureSession(fixture, 'staffALimited'),
					staffProfileId: fixture.ids.staffB.staffProfileId
				};
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('env-super-admin session → Unauthorized from loader always', async () => {
			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				await expectUnauthorized(() => getUserActor(envSuperAdminSession(), actorDb));
			});
		});

		await t.test('fixtureSession IDs reconcile with DB-loaded actor profile IDs', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				for (const { actor, assertActor } of HAPPY_ACTOR_CASES) {
					const session = fixtureSession(fixture, actor);
					const loaded = await getUserActor(session, actorDb);
					assert.equal(loaded.userId, session.userId);
					assertActor(loaded, fixture);

					if (loaded.role === 'LANDLORD') {
						assert.equal(loaded.landlordId, session.landlordProfileId);
					}
					if (loaded.role === 'TENANT') {
						assert.equal(loaded.tenantProfileId, session.tenantProfileId);
					}
					if (loaded.role === 'STAFF') {
						assert.equal(loaded.staffId, session.staffProfileId);
						assert.equal(loaded.landlordId, session.staffLandlordId);
					}
				}
			});
		});
	});
}
