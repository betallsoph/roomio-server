import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionData } from '$lib/server/session';
import { resetEnvForTests } from '$lib/server/env';
import { UnauthorizedError } from './errors.js';
import type { ActorDb } from './load-user-actor.js';

const { getUserActor, isTransitionalEnvSuperAdminSession, isEnvFakeSuperAdminUserId } =
	await import('./load-user-actor.js');

const USER_ID = 'user-1';
const LANDLORD_ID = 'landlord-profile-1';
const TENANT_PROFILE_ID = 'tenant-profile-1';
const STAFF_ID = 'staff-profile-1';
const STAFF_LANDLORD_ID = 'landlord-for-staff-1';

const VALID_PROD_ENV: NodeJS.ProcessEnv = {
	NODE_ENV: 'production',
	DATABASE_URL: 'postgres://roomio:super-secret-db-pass@db.private.network:5432/roomio',
	SESSION_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
	ORIGIN: 'https://api.roomio.example.com',
	PUBLIC_APP_ORIGIN: 'https://app.roomio.example.com',
	SUPER_ADMIN_ACCOUNTS: 'owner@example.com:a-long-random-owner-passphrase-2026'
};

function baseSession(overrides: Partial<SessionData> = {}): SessionData {
	return {
		userId: USER_ID,
		role: 'LANDLORD',
		landlordProfileId: null,
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null,
		...overrides
	};
}

function createMockDb(overrides: Partial<ActorDb> = {}): ActorDb {
	return {
		findUserById: async () => ({ isActive: true, role: 'LANDLORD' }),
		findLandlordProfileByUserId: async () => ({ id: LANDLORD_ID }),
		findTenantProfileByUserId: async () => ({ id: TENANT_PROFILE_ID }),
		findStaffProfileByUserId: async () => ({ id: STAFF_ID, landlordId: STAFF_LANDLORD_ID }),
		...overrides
	};
}

async function expectUnauthorized(run: () => Promise<unknown>): Promise<void> {
	await assert.rejects(run, (error: unknown) => {
		assert.ok(error instanceof UnauthorizedError);
		assert.equal(error.status, 401);
		return true;
	});
}

test('active landlord → landlord ActorContext with DB landlordId', async () => {
	const actor = await getUserActor(
		baseSession({ role: 'LANDLORD', landlordProfileId: LANDLORD_ID }),
		createMockDb()
	);

	assert.deepEqual(actor, {
		kind: 'USER',
		userId: USER_ID,
		role: 'LANDLORD',
		landlordId: LANDLORD_ID
	});
});

test('active tenant → tenant ActorContext with DB tenantProfileId', async () => {
	const actor = await getUserActor(
		baseSession({ role: 'TENANT', tenantProfileId: TENANT_PROFILE_ID }),
		createMockDb({
			findUserById: async () => ({ isActive: true, role: 'TENANT' })
		})
	);

	assert.deepEqual(actor, {
		kind: 'USER',
		userId: USER_ID,
		role: 'TENANT',
		tenantProfileId: TENANT_PROFILE_ID
	});
});

test('active staff → staff ActorContext with empty propertyIds and permissions', async () => {
	const actor = await getUserActor(
		baseSession({
			role: 'STAFF',
			staffProfileId: STAFF_ID,
			staffLandlordId: STAFF_LANDLORD_ID
		}),
		createMockDb({
			findUserById: async () => ({ isActive: true, role: 'STAFF' })
		})
	);

	assert.deepEqual(actor, {
		kind: 'USER',
		userId: USER_ID,
		role: 'STAFF',
		staffId: STAFF_ID,
		landlordId: STAFF_LANDLORD_ID,
		propertyIds: [],
		permissions: []
	});
});

test('active DB super admin → SUPER_ADMIN ActorContext without landlordId', async () => {
	const actor = await getUserActor(
		baseSession({ role: 'SUPER_ADMIN' }),
		createMockDb({
			findUserById: async () => ({ isActive: true, role: 'SUPER_ADMIN' })
		})
	);

	assert.deepEqual(actor, {
		kind: 'USER',
		userId: USER_ID,
		role: 'SUPER_ADMIN'
	});
	assert.equal('landlordId' in actor, false);
});

test('inactive user → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession(),
			createMockDb({
				findUserById: async () => ({ isActive: false, role: 'LANDLORD' })
			})
		)
	);
});

test('missing user → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession(),
			createMockDb({
				findUserById: async () => null
			})
		)
	);
});

test('role change between session and DB → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession({ role: 'LANDLORD' }),
			createMockDb({
				findUserById: async () => ({ isActive: true, role: 'TENANT' })
			})
		)
	);
});

test('landlord missing profile → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession({ role: 'LANDLORD' }),
			createMockDb({
				findLandlordProfileByUserId: async () => null
			})
		)
	);
});

test('tenant missing profile → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession({ role: 'TENANT' }),
			createMockDb({
				findUserById: async () => ({ isActive: true, role: 'TENANT' }),
				findTenantProfileByUserId: async () => null
			})
		)
	);
});

test('staff missing profile → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession({ role: 'STAFF' }),
			createMockDb({
				findUserById: async () => ({ isActive: true, role: 'STAFF' }),
				findStaffProfileByUserId: async () => null
			})
		)
	);
});

test('landlord session landlordProfileId mismatch → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession({ role: 'LANDLORD', landlordProfileId: 'stale-landlord-id' }),
			createMockDb()
		)
	);
});

test('tenant session tenantProfileId mismatch → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession({ role: 'TENANT', tenantProfileId: 'stale-tenant-id' }),
			createMockDb({
				findUserById: async () => ({ isActive: true, role: 'TENANT' })
			})
		)
	);
});

test('staff session staffProfileId mismatch → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession({
				role: 'STAFF',
				staffProfileId: 'stale-staff-id',
				staffLandlordId: STAFF_LANDLORD_ID
			}),
			createMockDb({
				findUserById: async () => ({ isActive: true, role: 'STAFF' })
			})
		)
	);
});

test('staff session staffLandlordId mismatch → UnauthorizedError', async () => {
	await expectUnauthorized(() =>
		getUserActor(
			baseSession({
				role: 'STAFF',
				staffProfileId: STAFF_ID,
				staffLandlordId: 'stale-landlord-id'
			}),
			createMockDb({
				findUserById: async () => ({ isActive: true, role: 'STAFF' })
			})
		)
	);
});

test('env fake super admin session in production → UnauthorizedError', async () => {
	resetEnvForTests(VALID_PROD_ENV);
	try {
		await expectUnauthorized(() =>
			getUserActor(
				{
					userId: 'env-super-admin',
					role: 'SUPER_ADMIN',
					landlordProfileId: null,
					tenantProfileId: null,
					staffProfileId: null,
					staffLandlordId: null
				},
				createMockDb()
			)
		);
	} finally {
		resetEnvForTests();
	}
});

test('env fake super admin session in development → UnauthorizedError (loader always rejects)', async () => {
	resetEnvForTests({
		NODE_ENV: 'development',
		SUPER_ADMIN_ACCOUNTS: 'dev@example.com:dev-password-long-enough'
	});
	try {
		await expectUnauthorized(() =>
			getUserActor(
				{
					userId: 'env-super-admin:0',
					role: 'SUPER_ADMIN',
					landlordProfileId: null,
					tenantProfileId: null,
					staffProfileId: null,
					staffLandlordId: null
				},
				createMockDb()
			)
		);
	} finally {
		resetEnvForTests();
	}
});

test('isEnvFakeSuperAdminUserId recognizes legacy env session IDs', () => {
	assert.equal(isEnvFakeSuperAdminUserId('env-super-admin'), true);
	assert.equal(isEnvFakeSuperAdminUserId('env-super-admin:0'), true);
	assert.equal(isEnvFakeSuperAdminUserId('hardcoded-super-admin'), true);
	assert.equal(isEnvFakeSuperAdminUserId('real-db-user-id'), false);
});

test('isTransitionalEnvSuperAdminSession true only in development with SUPER_ADMIN_ACCOUNTS', () => {
	const envSession: SessionData = {
		userId: 'env-super-admin',
		role: 'SUPER_ADMIN',
		landlordProfileId: null,
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null
	};

	resetEnvForTests({
		NODE_ENV: 'development',
		SUPER_ADMIN_ACCOUNTS: 'dev@example.com:dev-password-long-enough'
	});
	try {
		assert.equal(isTransitionalEnvSuperAdminSession(envSession), true);
	} finally {
		resetEnvForTests();
	}

	resetEnvForTests(VALID_PROD_ENV);
	try {
		assert.equal(isTransitionalEnvSuperAdminSession(envSession), false);
	} finally {
		resetEnvForTests();
	}

	resetEnvForTests({ NODE_ENV: 'development' });
	try {
		assert.equal(isTransitionalEnvSuperAdminSession(envSession), false);
	} finally {
		resetEnvForTests();
	}
});

test('null cookie profile IDs do not block when DB profile exists', async () => {
	const actor = await getUserActor(
		baseSession({ role: 'LANDLORD', landlordProfileId: null }),
		createMockDb()
	);

	assert.equal(actor.role, 'LANDLORD');
	assert.equal('landlordId' in actor && actor.landlordId, LANDLORD_ID);
});
