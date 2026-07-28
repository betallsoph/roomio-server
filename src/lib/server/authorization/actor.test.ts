import assert from 'node:assert/strict';
import test from 'node:test';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	unauthenticatedError,
	wrongActorKindError
} from './errors.js';
import {
	requireLandlordActor,
	requireRole,
	requireStaffActor,
	requireSuperAdminActor,
	requireTenantActor,
	type ActorContext,
	type LandlordActor,
	type StaffActor,
	type SuperAdminActor,
	type TenantActor
} from './actor.js';

const superAdmin: SuperAdminActor = {
	kind: 'USER',
	userId: 'admin-1',
	role: 'SUPER_ADMIN'
};

const landlord: LandlordActor = {
	kind: 'USER',
	userId: 'user-landlord',
	role: 'LANDLORD',
	landlordId: 'landlord-1'
};

const staff: StaffActor = {
	kind: 'USER',
	userId: 'user-staff',
	role: 'STAFF',
	staffId: 'staff-1',
	landlordId: 'landlord-1',
	propertyIds: ['property-1'],
	permissions: ['VIEW_ROOMS', 'MANAGE_METERS', 'UPLOAD']
};

const tenant: TenantActor = {
	kind: 'USER',
	userId: 'user-tenant',
	role: 'TENANT',
	tenantProfileId: 'tenant-profile-1'
};

const machine: ActorContext = {
	kind: 'MACHINE',
	channel: 'QSTASH',
	requestId: 'job-1',
	verifiedAccountId: 'acct-1'
};

function landlordIdFrom(actor: LandlordActor): string {
	return actor.landlordId;
}

function tenantProfileIdFrom(actor: TenantActor): string {
	return actor.tenantProfileId;
}

function staffScopeFrom(actor: StaffActor): { staffId: string; propertyIds: string[] } {
	return { staffId: actor.staffId, propertyIds: actor.propertyIds };
}

test('requireSuperAdminActor accepts SUPER_ADMIN without landlordId', () => {
	const result = requireSuperAdminActor(superAdmin);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.userId, 'admin-1');
	assert.equal('landlordId' in result.value, false);
	assert.equal('tenantProfileId' in result.value, false);
	assert.equal('managedTenantId' in result.value, false);
});

test('requireSuperAdminActor rejects other user roles and machine actors', () => {
	for (const actor of [landlord, staff, tenant, machine] as ActorContext[]) {
		const result = requireSuperAdminActor(actor);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.error.status, 403);
		assert.equal(result.error.code, actor.kind === 'MACHINE' ? 'WRONG_ACTOR_KIND' : 'WRONG_ROLE');
	}
});

test('requireLandlordActor narrows to landlordId', () => {
	const result = requireLandlordActor(landlord);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(landlordIdFrom(result.value), 'landlord-1');
});

test('requireLandlordActor rejects machine actor with WRONG_ACTOR_KIND', () => {
	const result = requireLandlordActor(machine);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.status, 403);
	assert.equal(result.error.code, 'WRONG_ACTOR_KIND');
});

test('requireStaffActor preserves staff scope fields', () => {
	const result = requireStaffActor(staff);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	const scope = staffScopeFrom(result.value);
	assert.equal(scope.staffId, 'staff-1');
	assert.deepEqual(scope.propertyIds, ['property-1']);
	assert.deepEqual(result.value.permissions, ['VIEW_ROOMS', 'MANAGE_METERS', 'UPLOAD']);
});

test('requireTenantActor exposes only userId and tenantProfileId', () => {
	const result = requireTenantActor(tenant);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(tenantProfileIdFrom(result.value), 'tenant-profile-1');
	assert.equal('managedTenantId' in result.value, false);
	assert.equal('landlordId' in result.value, false);
});

test('requireRole supports multi-role narrowing', () => {
	const landlordResult = requireRole(landlord, ['LANDLORD', 'STAFF'] as const);
	assert.equal(landlordResult.ok, true);
	if (!landlordResult.ok) return;
	assert.equal(landlordResult.value.role, 'LANDLORD');

	const staffResult = requireRole(staff, ['LANDLORD', 'STAFF'] as const);
	assert.equal(staffResult.ok, true);
	if (!staffResult.ok) return;
	assert.equal(staffResult.value.role, 'STAFF');
});

test('requireRole rejects tenant for landlord-only roles', () => {
	const result = requireRole(tenant, ['LANDLORD'] as const);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.status, 403);
	assert.equal(result.error.code, 'FORBIDDEN');
});

test('requireRole rejects machine actor', () => {
	const result = requireRole(machine, ['LANDLORD'] as const);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.code, 'WRONG_ACTOR_KIND');
});

test('AuthorizationError factories and response conversion', async () => {
	const error = unauthenticatedError();
	assert.equal(error.status, 401);
	assert.equal(error.code, 'UNAUTHENTICATED');
	assert.equal(isAuthorizationError(error), true);
	assert.equal(isAuthorizationError(new Error('x')), false);

	const response = authorizationErrorToResponse(wrongActorKindError());
	assert.equal(response.status, 403);
	const body = (await response.json()) as { error: string };
	assert.equal(body.error, 'Chỉ tài khoản người dùng được phép truy cập');
});
