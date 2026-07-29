import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActorContext, LandlordActor, StaffActor, TenantActor } from './actor.js';
import type { PolicyContext } from './capabilities.js';
import { authorizeActor, isOperationalUserActor, operationalActorDenyReason } from './policies.js';

const landlordA: LandlordActor = {
	kind: 'USER',
	userId: 'landlord-user-a',
	role: 'LANDLORD',
	landlordId: 'landlord-a'
};

const landlordB: LandlordActor = {
	kind: 'USER',
	userId: 'landlord-user-b',
	role: 'LANDLORD',
	landlordId: 'landlord-b'
};

const staffMeter: StaffActor = {
	kind: 'USER',
	userId: 'staff-user-1',
	role: 'STAFF',
	staffId: 'staff-1',
	landlordId: 'landlord-a',
	propertyIds: ['property-a1'],
	permissions: ['MANAGE_METERS']
};

const staffRoomsOnly: StaffActor = {
	...staffMeter,
	permissions: ['VIEW_ROOMS']
};

const tenant: TenantActor = {
	kind: 'USER',
	userId: 'tenant-user-1',
	role: 'TENANT',
	tenantProfileId: 'tenant-profile-1'
};

const machine: ActorContext = {
	kind: 'MACHINE',
	channel: 'QSTASH',
	requestId: 'job-1'
};

const machinePayment: ActorContext = {
	kind: 'MACHINE',
	channel: 'PAYMENT_WEBHOOK',
	requestId: 'pay-1',
	verifiedAccountId: 'acct-1'
};

const superAdmin: ActorContext = {
	kind: 'USER',
	userId: 'admin-1',
	role: 'SUPER_ADMIN'
};

function baseContext(overrides: Partial<PolicyContext['resource']> = {}): PolicyContext {
	return {
		resource: {
			landlordId: 'landlord-a',
			propertyId: 'property-a1',
			managedTenantId: 'managed-tenant-1',
			tenancyId: 'tenancy-1',
			claimedByUserId: tenant.userId,
			tenancyStatus: 'ACTIVE',
			...overrides
		},
		tenant: {
			claimedManagedTenantIds: ['managed-tenant-1'],
			tenancyIds: ['tenancy-1'],
			activeTenancyIds: ['tenancy-1']
		}
	};
}

test('authorizeActor denies machine actors by default', () => {
	const result = authorizeActor(machine, 'property', 'list', baseContext());
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, 'WRONG_ACTOR_KIND');

	const paymentMachine = authorizeActor(machinePayment, 'invoice', 'detail', baseContext());
	assert.equal(paymentMachine.ok, false);
	if (paymentMachine.ok) return;
	assert.equal(paymentMachine.reason, 'WRONG_ACTOR_KIND');
});

test('operationalActorDenyReason blocks machine and super admin specifically', () => {
	assert.equal(operationalActorDenyReason(machine), 'WRONG_ACTOR_KIND');
	assert.equal(operationalActorDenyReason(machinePayment), 'WRONG_ACTOR_KIND');
	assert.equal(operationalActorDenyReason(superAdmin), 'SUPER_ADMIN_OPERATIONAL');
	assert.equal(operationalActorDenyReason(landlordA), null);
	assert.equal(operationalActorDenyReason(tenant), null);
});

test('isOperationalUserActor rejects machine and super admin, not other user roles', () => {
	assert.equal(isOperationalUserActor(machine), false);
	assert.equal(isOperationalUserActor(superAdmin), false);
	assert.equal(isOperationalUserActor(landlordA), true);
	assert.equal(isOperationalUserActor(staffMeter), true);
	assert.equal(isOperationalUserActor(tenant), true);
});

test('authorizeActor denies super admin operational resources', () => {
	const result = authorizeActor(superAdmin, 'property', 'list', baseContext());
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, 'SUPER_ADMIN_OPERATIONAL');

	const meter = authorizeActor(superAdmin, 'meter', 'approve', baseContext());
	assert.equal(meter.ok, false);
	if (meter.ok) return;
	assert.equal(meter.reason, 'SUPER_ADMIN_OPERATIONAL');
});

test('landlord own-scope allows property list; cross-landlord denies', () => {
	const own = authorizeActor(landlordA, 'property', 'list', baseContext());
	assert.equal(own.ok, true);

	const foreign = authorizeActor(landlordB, 'property', 'list', baseContext());
	assert.equal(foreign.ok, false);
	if (foreign.ok) return;
	assert.equal(foreign.reason, 'LANDLORD_SCOPE');
});

test('staff meter read requires MANAGE_METERS and property assignment', () => {
	const allowed = authorizeActor(staffMeter, 'meter', 'detail', baseContext());
	assert.equal(allowed.ok, true);

	const wrongProperty = authorizeActor(
		staffMeter,
		'meter',
		'detail',
		baseContext({ propertyId: 'property-other' })
	);
	assert.equal(wrongProperty.ok, false);
	if (wrongProperty.ok) return;
	assert.equal(wrongProperty.reason, 'STAFF_PROPERTY');

	const wrongCapability = authorizeActor(staffRoomsOnly, 'meter', 'detail', baseContext());
	assert.equal(wrongCapability.ok, false);
	if (wrongCapability.ok) return;
	assert.equal(wrongCapability.reason, 'STAFF_CAPABILITY');
});

test('staff VIEW_TENANTS read requires ACTIVE tenancy status', () => {
	const staffTenants: StaffActor = {
		...staffMeter,
		permissions: ['VIEW_TENANTS']
	};
	const active = authorizeActor(
		staffTenants,
		'managedTenant',
		'detail',
		baseContext({ tenancyStatus: 'ACTIVE' })
	);
	assert.equal(active.ok, true);

	const ended = authorizeActor(
		staffTenants,
		'managedTenant',
		'detail',
		baseContext({ tenancyStatus: 'ENDED' })
	);
	assert.equal(ended.ok, false);
	if (ended.ok) return;
	assert.equal(ended.reason, 'STAFF_TENANCY_STATUS');
});

test('staff property read allows VIEW_ROOMS on assigned property', () => {
	const allowed = authorizeActor(staffRoomsOnly, 'room', 'detail', baseContext());
	assert.equal(allowed.ok, true);

	const noCapabilityStaff: StaffActor = {
		...staffMeter,
		permissions: []
	};
	const denied = authorizeActor(noCapabilityStaff, 'room', 'detail', baseContext());
	assert.equal(denied.ok, false);
	if (denied.ok) return;
	assert.equal(denied.reason, 'STAFF_CAPABILITY');
});

test('staff invoice access is denied in MVP', () => {
	const result = authorizeActor(staffMeter, 'invoice', 'detail', baseContext());
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, 'DEFAULT_DENY');
});

test('tenant can read claimed managed tenant and own tenancy invoice', () => {
	const managedTenant = authorizeActor(tenant, 'managedTenant', 'detail', baseContext());
	assert.equal(managedTenant.ok, true);

	const invoice = authorizeActor(tenant, 'invoice', 'detail', baseContext());
	assert.equal(invoice.ok, true);
});

test('tenant denied for unclaimed managed tenant and landlord-only actions', () => {
	const unclaimed = authorizeActor(
		tenant,
		'managedTenant',
		'detail',
		baseContext({ claimedByUserId: 'other-user', managedTenantId: 'managed-tenant-2' })
	);
	assert.equal(unclaimed.ok, false);
	if (unclaimed.ok) return;
	assert.equal(unclaimed.reason, 'TENANT_CLAIM');

	const createProperty = authorizeActor(tenant, 'property', 'create', baseContext());
	assert.equal(createProperty.ok, false);
	if (createProperty.ok) return;
	assert.equal(createProperty.reason, 'DEFAULT_DENY');
});

test('tenant asset / conversation / file surfaces default deny until resolvers land', () => {
	for (const action of ['list', 'detail', 'create', 'update'] as const) {
		const asset = authorizeActor(tenant, 'asset', action, baseContext());
		assert.equal(asset.ok, false);
		if (!asset.ok) assert.equal(asset.reason, 'DEFAULT_DENY');

		const conversation = authorizeActor(tenant, 'conversation', action, baseContext());
		assert.equal(conversation.ok, false);
		if (!conversation.ok) assert.equal(conversation.reason, 'DEFAULT_DENY');
	}

	for (const visibility of ['LANDLORD_ONLY', 'TENANT_CAN_VIEW', undefined] as const) {
		const result = authorizeActor(
			tenant,
			'file',
			'detail',
			baseContext(visibility === undefined ? {} : { fileVisibility: visibility })
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'DEFAULT_DENY');
	}
});

test('landlord conversation and file surfaces default deny until AUTH-014/DATA-002', () => {
	for (const action of ['list', 'detail', 'create', 'update', 'delete'] as const) {
		const conversation = authorizeActor(landlordA, 'conversation', action, baseContext());
		assert.equal(conversation.ok, false);
		if (!conversation.ok) assert.equal(conversation.reason, 'DEFAULT_DENY');

		const file = authorizeActor(landlordA, 'file', action, baseContext());
		assert.equal(file.ok, false);
		if (!file.ok) assert.equal(file.reason, 'DEFAULT_DENY');
	}
});

test('tenant file mutations default deny until self-upload policy exists', () => {
	for (const action of ['create', 'update', 'delete'] as const) {
		const result = authorizeActor(tenant, 'file', action, baseContext());
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, 'DEFAULT_DENY');
	}
});

test('tenant meter submit requires active tenancy', () => {
	const active = authorizeActor(tenant, 'meter', 'submit', baseContext());
	assert.equal(active.ok, true);

	const ended = authorizeActor(tenant, 'meter', 'submit', baseContext({ tenancyStatus: 'ENDED' }));
	assert.equal(ended.ok, false);
	if (ended.ok) return;
	assert.equal(ended.reason, 'TENANT_SCOPE');
});

test('wrong role landlord action denied for tenant', () => {
	const result = authorizeActor(tenant, 'invoice', 'approve', baseContext());
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, 'DEFAULT_DENY');
});
