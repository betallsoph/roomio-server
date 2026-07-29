import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActorContext, LandlordActor, StaffActor, TenantActor } from './actor.js';
import type { PolicyContext } from './capabilities.js';
import { authorizeActor } from './policies.js';

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
});

test('authorizeActor denies super admin operational resources', () => {
	const result = authorizeActor(superAdmin, 'property', 'list', baseContext());
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, 'SUPER_ADMIN_OPERATIONAL');
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

test('tenant file read denies LANDLORD_ONLY visibility', () => {
	const hidden = authorizeActor(
		tenant,
		'file',
		'detail',
		baseContext({ fileVisibility: 'LANDLORD_ONLY' })
	);
	assert.equal(hidden.ok, false);
	if (hidden.ok) return;
	assert.equal(hidden.reason, 'TENANT_VISIBILITY');

	const visible = authorizeActor(
		tenant,
		'file',
		'detail',
		baseContext({ fileVisibility: 'TENANT_CAN_VIEW' })
	);
	assert.equal(visible.ok, true);
});

test('tenant meter submit requires active tenancy', () => {
	const active = authorizeActor(tenant, 'meter', 'submit', baseContext());
	assert.equal(active.ok, true);

	const ended = authorizeActor(
		tenant,
		'meter',
		'submit',
		baseContext({ tenancyStatus: 'ENDED' })
	);
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
