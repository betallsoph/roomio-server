import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { SessionData } from '../session.js';
import { landlordProfiles, staffProfiles, tenantProfiles, users } from '../db/schema.js';
import { UnauthorizedError } from './errors.js';
import type { ActorDb } from './load-user-actor.js';
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
	const { db } = handle;
	return {
		async findUserById(userId) {
			const row = await db.query.users.findFirst({
				where: eq(users.id, userId),
				columns: { isActive: true, role: true }
			});
			return row ?? null;
		},
		async findLandlordProfileByUserId(userId) {
			const row = await db.query.landlordProfiles.findFirst({
				where: eq(landlordProfiles.userId, userId),
				columns: { id: true }
			});
			return row ?? null;
		},
		async findTenantProfileByUserId(userId) {
			const row = await db.query.tenantProfiles.findFirst({
				where: eq(tenantProfiles.userId, userId),
				columns: { id: true }
			});
			return row ?? null;
		},
		async findStaffProfileByUserId(userId) {
			const row = await db.query.staffProfiles.findFirst({
				where: eq(staffProfiles.userId, userId),
				columns: { id: true, landlordId: true }
			});
			return row ?? null;
		}
	};
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
			assert.deepEqual(actor.propertyIds, []);
			assert.deepEqual(actor.permissions, []);
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
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const session = fixtureSession(fixture, 'landlordA');
				await handle.db.delete(users).where(eq(users.id, fixture.ids.landlordA.userId));
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('landlord missing profile row → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const session = fixtureSession(fixture, 'landlordA');
				await handle.db
					.delete(landlordProfiles)
					.where(eq(landlordProfiles.userId, fixture.ids.landlordA.userId));
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('tenant missing profile row → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const session = fixtureSession(fixture, 'tenantANow');
				await handle.db
					.delete(tenantProfiles)
					.where(eq(tenantProfiles.userId, fixture.ids.tenantANow.userId));
				await expectUnauthorized(() => getUserActor(session, actorDb));
			});
		});

		await t.test('staff missing profile row → Unauthorized', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actorDb = createActorDbFromHandle(handle);
				const session = fixtureSession(fixture, 'staffALimited');
				await handle.db
					.delete(staffProfiles)
					.where(eq(staffProfiles.userId, fixture.ids.staffALimited.userId));
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
