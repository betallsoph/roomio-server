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
	const src = readFileSync(
		new URL('../../routes/api/staff/+server.ts', import.meta.url),
		'utf8'
	);
	const match = src.match(/export const STAFF_USER_COLUMNS\s*=\s*\{([^}]+)\}/);
	assert.ok(match, 'STAFF_USER_COLUMNS export found');
	const columnsBlock = match[1];
	assert.doesNotMatch(columnsBlock, /passwordHash/);
	for (const col of ['id', 'name', 'email', 'phone', 'isActive']) {
		assert.match(columnsBlock, new RegExp(`\\b${col}\\b`));
	}
});

test('POST/PUT/DELETE unchanged — still scope via session landlord', () => {
	const src = readFileSync(
		new URL('../../routes/api/staff/+server.ts', import.meta.url),
		'utf8'
	);

	assert.match(src, /export const POST[\s\S]*locals\.session\?\.landlordProfileId/);
	assert.match(
		src,
		/export const PUT[\s\S]*profile\.landlordId !== locals\.session\.landlordProfileId/
	);
	assert.match(
		src,
		/export const DELETE[\s\S]*profile\.landlordId !== locals\.session\.landlordProfileId/
	);
	assert.doesNotMatch(src, /export const POST[\s\S]*url\.searchParams\.get\('landlordId'\)/);
});
