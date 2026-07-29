import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { resolveLandlordScopeForList } = await import('./landlord-query-scope.js');

const LANDLORD_A = 'landlord-a';
const LANDLORD_B = 'landlord-b';

function baseSession(overrides: Record<string, unknown> = {}) {
	return {
		userId: 'user-1',
		role: 'LANDLORD',
		landlordProfileId: LANDLORD_A,
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null,
		...overrides
	};
}

test('landlord A no param → scope A', () => {
	const result = resolveLandlordScopeForList(baseSession(), null);
	assert.deepEqual(result, { landlordId: LANDLORD_A });
});

test('landlord A sends B → 403', () => {
	const result = resolveLandlordScopeForList(baseSession(), LANDLORD_B);
	assert.equal('error' in result && result.status, 403);
});

test('tenant with landlordId B → 403', () => {
	const result = resolveLandlordScopeForList(
		baseSession({ role: 'TENANT', landlordProfileId: null, tenantProfileId: 'tenant-1' }),
		LANDLORD_B
	);
	assert.equal('error' in result && result.status, 403);
});

test('staff with landlordId A → 403', () => {
	const result = resolveLandlordScopeForList(
		baseSession({
			role: 'STAFF',
			landlordProfileId: null,
			staffProfileId: 'staff-1',
			staffLandlordId: LANDLORD_A
		}),
		LANDLORD_A
	);
	assert.equal('error' in result && result.status, 403);
});

test('staff with landlordId B → 403', () => {
	const result = resolveLandlordScopeForList(
		baseSession({
			role: 'STAFF',
			landlordProfileId: null,
			staffProfileId: 'staff-1',
			staffLandlordId: LANDLORD_A
		}),
		LANDLORD_B
	);
	assert.equal('error' in result && result.status, 403);
});

test('super-admin missing scope → 400', () => {
	const result = resolveLandlordScopeForList(
		baseSession({ role: 'SUPER_ADMIN', landlordProfileId: null }),
		null
	);
	assert.equal('error' in result && result.status, 400);
});

test('super-admin scope A → A', () => {
	const result = resolveLandlordScopeForList(
		baseSession({ role: 'SUPER_ADMIN', landlordProfileId: null }),
		LANDLORD_A
	);
	assert.deepEqual(result, { landlordId: LANDLORD_A });
});

test('no session → 401', () => {
	const result = resolveLandlordScopeForList(null, LANDLORD_A);
	assert.equal('error' in result && result.status, 401);
});

test('staff response columns exclude passwordHash', () => {
	const src = readFileSync(new URL('../../routes/api/staff/+server.ts', import.meta.url), 'utf8');
	const match = src.match(/const STAFF_USER_COLUMNS\s*=\s*\{([^}]+)\}/);
	assert.ok(match, 'STAFF_USER_COLUMNS declaration found');
	const columnsBlock = match[1];
	assert.doesNotMatch(columnsBlock, /passwordHash/);
	for (const col of ['id', 'name', 'email', 'phone', 'isActive']) {
		assert.match(columnsBlock, new RegExp(`\\b${col}\\b`));
	}
});

test('AUTH-005 staff routes use ActorContext only — no session landlord / query landlordId', async () => {
	const staffSrc = readFileSync(
		new URL('../../routes/api/staff/+server.ts', import.meta.url),
		'utf8'
	);
	const landlordRequestSrc = readFileSync(
		new URL('./staff/landlord-request.ts', import.meta.url),
		'utf8'
	);

	for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
		assert.match(
			staffSrc,
			new RegExp(
				`export const ${method}[\\s\\S]*resolveLandlordActorFromRequest\\(\\{\\s*actor:\\s*locals\\.actor`
			),
			`${method} must call resolveLandlordActorFromRequest({ actor: locals.actor })`
		);
	}

	assert.doesNotMatch(staffSrc, /resolveLandlordScopeForList/);
	assert.doesNotMatch(staffSrc, /locals\.session\?\.landlordProfileId/);
	assert.doesNotMatch(staffSrc, /locals\.session\.landlordProfileId/);
	assert.doesNotMatch(staffSrc, /searchParams\.get\(['"]landlordId['"]\)/);
	assert.doesNotMatch(staffSrc, /body\.landlordId|landlordId\s*=\s*body/);

	const landlordRequestCode = landlordRequestSrc
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');
	assert.match(landlordRequestSrc, /requireLandlordActor/);
	assert.doesNotMatch(landlordRequestCode, /input\.session|SessionData|landlordProfileId/);
	assert.match(
		landlordRequestSrc,
		/Never trust locals\.session/,
		'helper documents ActorContext-only contract'
	);

	const { resolveLandlordActorFromRequest } = await import('./staff/landlord-request.js');

	const nullActor = resolveLandlordActorFromRequest({ actor: null });
	assert.equal(nullActor.ok, false);
	if (!nullActor.ok) assert.equal(nullActor.response.status, 401);

	const superAdmin = resolveLandlordActorFromRequest({
		actor: { kind: 'USER', userId: 'sa', role: 'SUPER_ADMIN' }
	});
	assert.equal(superAdmin.ok, false);
	if (!superAdmin.ok) assert.equal(superAdmin.response.status, 403);

	const staff = resolveLandlordActorFromRequest({
		actor: {
			kind: 'USER',
			userId: 's',
			role: 'STAFF',
			staffId: 'sid',
			landlordId: LANDLORD_A,
			propertyIds: [],
			permissions: []
		}
	});
	assert.equal(staff.ok, false);
	if (!staff.ok) assert.equal(staff.response.status, 403);

	const tenant = resolveLandlordActorFromRequest({
		actor: {
			kind: 'USER',
			userId: 't',
			role: 'TENANT',
			tenantProfileId: 'tid'
		}
	});
	assert.equal(tenant.ok, false);
	if (!tenant.ok) assert.equal(tenant.response.status, 403);

	const landlord = resolveLandlordActorFromRequest({
		actor: {
			kind: 'USER',
			userId: 'u',
			role: 'LANDLORD',
			landlordId: LANDLORD_A
		}
	});
	assert.equal(landlord.ok, true);
	if (landlord.ok) assert.equal(landlord.actor.landlordId, LANDLORD_A);
});
