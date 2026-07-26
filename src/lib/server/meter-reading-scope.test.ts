import assert from 'node:assert/strict';
import test from 'node:test';

const { resolveMeterReadingScope, TENANCY_HISTORY_NOT_READY } = await import(
	'./meter-reading-scope.js'
);

type Session = {
	userId: string;
	role: string;
	landlordProfileId: string | null;
	tenantProfileId: string | null;
	staffProfileId: string | null;
	staffLandlordId: string | null;
};

function session(role: string, over: Partial<Session> = {}): Session {
	return {
		userId: 'u-' + role,
		role,
		landlordProfileId: null,
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null,
		...over
	};
}

test('no session → 401, no landlord scope', () => {
	const d = resolveMeterReadingScope(null, { landlordId: 'landlord-b' });
	assert.equal(d.ok, false);
	assert.equal(d.ok === false && d.status, 401);
});

test('LANDLORD scope always comes from session, ignoring query landlordId', () => {
	const d = resolveMeterReadingScope(session('LANDLORD', { landlordProfileId: 'landlord-a' }), {
		landlordId: 'landlord-b'
	});
	assert.equal(d.ok, true);
	assert.equal(d.ok === true && d.landlordId, 'landlord-a');
});

test('LANDLORD passing tenantId of another landlord does not expand scope', () => {
	const d = resolveMeterReadingScope(session('LANDLORD', { landlordProfileId: 'landlord-a' }), {
		tenantId: 'tenant-b'
	});
	assert.equal(d.ok, true);
	assert.equal(d.ok === true && d.landlordId, 'landlord-a');
});

test('LANDLORD with missing landlordProfileId is denied (defensive)', () => {
	const d = resolveMeterReadingScope(session('LANDLORD', { landlordProfileId: null }), {});
	assert.equal(d.ok, false);
	assert.equal(d.ok === false && d.status, 403);
});

test('STAFF scope comes from staffLandlordId, query cannot cross landlord', () => {
	const d = resolveMeterReadingScope(session('STAFF', { staffLandlordId: 'landlord-a' }), {
		landlordId: 'landlord-b'
	});
	assert.equal(d.ok, true);
	assert.equal(d.ok === true && d.landlordId, 'landlord-a');
});

test('STAFF without staffLandlordId is denied', () => {
	const d = resolveMeterReadingScope(session('STAFF', { staffLandlordId: null }), {});
	assert.equal(d.ok, false);
	assert.equal(d.ok === false && d.status, 403);
});

test('TENANT is locked with 403 TENANCY_HISTORY_NOT_READY', () => {
	const d = resolveMeterReadingScope(session('TENANT', { tenantProfileId: 'tenant-a' }), {});
	assert.equal(d.ok, false);
	assert.equal(d.ok === false && d.status, 403);
	assert.equal(d.ok === false && d.code, TENANCY_HISTORY_NOT_READY);
	assert.equal(TENANCY_HISTORY_NOT_READY, 'TENANCY_HISTORY_NOT_READY');
});

test('TENANT passing another landlordId still gets 403, never that landlord data', () => {
	const d = resolveMeterReadingScope(session('TENANT', { tenantProfileId: 'tenant-a' }), {
		landlordId: 'landlord-b'
	});
	assert.equal(d.ok, false);
	assert.equal(d.ok === false && d.status, 403);
	assert.equal(d.ok === false && d.code, TENANCY_HISTORY_NOT_READY);
});

test('SUPER_ADMIN without explicit landlord scope → 400, no system-wide dump', () => {
	const d = resolveMeterReadingScope(session('SUPER_ADMIN'), {});
	assert.equal(d.ok, false);
	assert.equal(d.ok === false && d.status, 400);
});

test('SUPER_ADMIN with only tenantId (no landlordId) → still 400', () => {
	const d = resolveMeterReadingScope(session('SUPER_ADMIN'), { tenantId: 'tenant-a' });
	assert.equal(d.ok, false);
	assert.equal(d.ok === false && d.status, 400);
});

test('SUPER_ADMIN with explicit landlordId → scoped to exactly that landlord', () => {
	const d = resolveMeterReadingScope(session('SUPER_ADMIN'), { landlordId: '  landlord-a  ' });
	assert.equal(d.ok, true);
	assert.equal(d.ok === true && d.landlordId, 'landlord-a');
});

test('unknown role is denied by default', () => {
	const d = resolveMeterReadingScope(session('ROBOT'), { landlordId: 'landlord-a' });
	assert.equal(d.ok, false);
	assert.equal(d.ok === false && d.status, 403);
});
