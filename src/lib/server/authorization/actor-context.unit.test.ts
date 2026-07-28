import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionData } from '../session.js';
import { resetEnvForTests } from '../env.js';
import { UnauthorizedError } from './errors.js';
import type { ActorDb } from './load-user-actor.js';

const { getUserActor, isEnvFakeSuperAdminUserId, isTransitionalEnvSuperAdminSession } =
	await import('./load-user-actor.js');

const USER_ID = 'unit-user-1';
const LANDLORD_ID = 'unit-landlord-1';
const TENANT_PROFILE_ID = 'unit-tenant-1';
const STAFF_ID = 'unit-staff-1';
const STAFF_LANDLORD_ID = 'unit-staff-landlord-1';

function baseSession(overrides: Partial<SessionData> = {}): SessionData {
	return {
		userId: USER_ID,
		role: 'LANDLORD',
		landlordProfileId: null,
		enabledRentalTypes: null,
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
		listActiveStaffPropertyIds: async () => [],
		listActiveStaffPermissions: async () => [],
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

type CookieMismatchCase = {
	name: string;
	session: SessionData;
	mock: Partial<ActorDb>;
};

const COOKIE_MISMATCH_CASES: CookieMismatchCase[] = [
	{
		name: 'landlord landlordProfileId stale',
		session: baseSession({ role: 'LANDLORD', landlordProfileId: 'stale-landlord' }),
		mock: {}
	},
	{
		name: 'tenant tenantProfileId stale',
		session: baseSession({ role: 'TENANT', tenantProfileId: 'stale-tenant' }),
		mock: {
			findUserById: async () => ({ isActive: true, role: 'TENANT' })
		}
	},
	{
		name: 'staff staffProfileId stale',
		session: baseSession({
			role: 'STAFF',
			staffProfileId: 'stale-staff',
			staffLandlordId: STAFF_LANDLORD_ID
		}),
		mock: {
			findUserById: async () => ({ isActive: true, role: 'STAFF' })
		}
	},
	{
		name: 'staff staffLandlordId stale',
		session: baseSession({
			role: 'STAFF',
			staffProfileId: STAFF_ID,
			staffLandlordId: 'stale-landlord'
		}),
		mock: {
			findUserById: async () => ({ isActive: true, role: 'STAFF' })
		}
	}
];

for (const mismatchCase of COOKIE_MISMATCH_CASES) {
	test(`cookie mismatch matrix: ${mismatchCase.name} → UnauthorizedError`, async () => {
		await expectUnauthorized(() =>
			getUserActor(mismatchCase.session, createMockDb(mismatchCase.mock))
		);
	});
}

test('cookie match matrix: aligned session cookie IDs succeed for each role', async () => {
	const landlord = await getUserActor(
		baseSession({ role: 'LANDLORD', landlordProfileId: LANDLORD_ID }),
		createMockDb()
	);
	assert.deepEqual(landlord, {
		kind: 'USER',
		userId: USER_ID,
		role: 'LANDLORD',
		landlordId: LANDLORD_ID
	});

	const tenant = await getUserActor(
		baseSession({ role: 'TENANT', tenantProfileId: TENANT_PROFILE_ID }),
		createMockDb({ findUserById: async () => ({ isActive: true, role: 'TENANT' }) })
	);
	assert.deepEqual(tenant, {
		kind: 'USER',
		userId: USER_ID,
		role: 'TENANT',
		tenantProfileId: TENANT_PROFILE_ID
	});

	const staff = await getUserActor(
		baseSession({
			role: 'STAFF',
			staffProfileId: STAFF_ID,
			staffLandlordId: STAFF_LANDLORD_ID
		}),
		createMockDb({ findUserById: async () => ({ isActive: true, role: 'STAFF' }) })
	);
	assert.deepEqual(staff, {
		kind: 'USER',
		userId: USER_ID,
		role: 'STAFF',
		staffId: STAFF_ID,
		landlordId: STAFF_LANDLORD_ID,
		propertyIds: [],
		permissions: []
	});
});

test('null cookie profile IDs do not block DB authority (mismatch detector only when set)', async () => {
	const landlord = await getUserActor(
		baseSession({ role: 'LANDLORD', landlordProfileId: null }),
		createMockDb()
	);
	assert.equal(landlord.role, 'LANDLORD');
	if (landlord.role === 'LANDLORD') {
		assert.equal(landlord.landlordId, LANDLORD_ID);
	}
});

test('isEnvFakeSuperAdminUserId recognizes legacy env session IDs', () => {
	assert.equal(isEnvFakeSuperAdminUserId('env-super-admin'), true);
	assert.equal(isEnvFakeSuperAdminUserId('env-super-admin:0'), true);
	assert.equal(isEnvFakeSuperAdminUserId('hardcoded-super-admin'), true);
	assert.equal(isEnvFakeSuperAdminUserId('real-db-user-id'), false);
});

test('isTransitionalEnvSuperAdminSession is false in staging even with SUPER_ADMIN_ACCOUNTS', () => {
	resetEnvForTests({
		NODE_ENV: 'staging',
		SUPER_ADMIN_ACCOUNTS: 'dev@example.com:dev-password-long-enough'
	});
	try {
		const session = baseSession({ userId: 'env-super-admin', role: 'SUPER_ADMIN' });
		assert.equal(isTransitionalEnvSuperAdminSession(session), false);
	} finally {
		resetEnvForTests();
	}
});

test('isTransitionalEnvSuperAdminSession is false in production even with SUPER_ADMIN_ACCOUNTS', () => {
	resetEnvForTests({
		NODE_ENV: 'production',
		DATABASE_URL: 'postgres://roomio:super-secret-db-pass@db.private.network:5432/roomio',
		SESSION_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
		ORIGIN: 'https://api.roomio.example.com',
		PUBLIC_APP_ORIGIN: 'https://app.roomio.example.com',
		SUPER_ADMIN_ACCOUNTS: 'owner@example.com:a-long-random-owner-passphrase-2026'
	});
	try {
		const session = baseSession({ userId: 'env-super-admin', role: 'SUPER_ADMIN' });
		assert.equal(isTransitionalEnvSuperAdminSession(session), false);
	} finally {
		resetEnvForTests();
	}
});

test('isTransitionalEnvSuperAdminSession true only in development with SUPER_ADMIN_ACCOUNTS', () => {
	resetEnvForTests({
		NODE_ENV: 'development',
		SUPER_ADMIN_ACCOUNTS: 'dev@example.com:dev-password-long-enough'
	});
	try {
		const envSession = baseSession({ userId: 'env-super-admin', role: 'SUPER_ADMIN' });
		const dbSession = baseSession({ userId: 'real-db-user-id', role: 'SUPER_ADMIN' });
		assert.equal(isTransitionalEnvSuperAdminSession(envSession), true);
		assert.equal(isTransitionalEnvSuperAdminSession(dbSession), false);
	} finally {
		resetEnvForTests();
	}
});

test('getUserActor rejects env fake super admin even when transitional helper would allow hook bypass', async () => {
	resetEnvForTests({
		NODE_ENV: 'development',
		SUPER_ADMIN_ACCOUNTS: 'dev@example.com:dev-password-long-enough'
	});
	try {
		const session = baseSession({ userId: 'env-super-admin', role: 'SUPER_ADMIN' });
		assert.equal(isTransitionalEnvSuperAdminSession(session), true);
		await expectUnauthorized(() => getUserActor(session, createMockDb()));
	} finally {
		resetEnvForTests();
	}
});
