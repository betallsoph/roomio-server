import assert from 'node:assert/strict';
import test from 'node:test';
import {
	AUTHORIZATION_ACTIONS,
	AUTHORIZATION_RESOURCES,
	resolveStaffCapabilityRequirement,
	staffHasPropertyReadCapability,
	staffRequiresActiveTenancy,
	staffServiceReadCapability
} from './capabilities.js';

test('AUTHORIZATION_RESOURCES and ACTIONS are stable AUTH-008 vocabulary', () => {
	assert.deepEqual(AUTHORIZATION_RESOURCES, [
		'property',
		'room',
		'managedTenant',
		'tenancy',
		'invoice',
		'contract',
		'meter',
		'request',
		'asset',
		'service',
		'paymentAccount',
		'conversation',
		'file'
	]);
	assert.ok(AUTHORIZATION_ACTIONS.includes('list'));
	assert.ok(AUTHORIZATION_ACTIONS.includes('assign'));
});

test('resolveStaffCapabilityRequirement denies finance and messaging for staff MVP', () => {
	for (const resource of ['invoice', 'contract', 'paymentAccount', 'conversation', 'file'] as const) {
		for (const action of AUTHORIZATION_ACTIONS) {
			const requirement = resolveStaffCapabilityRequirement(resource, action);
			assert.equal(requirement.kind, 'DENY');
		}
	}
});

test('resolveStaffCapabilityRequirement maps operational resources to capabilities', () => {
	assert.deepEqual(resolveStaffCapabilityRequirement('property', 'list'), { kind: 'PROPERTY_READ' });
	assert.deepEqual(resolveStaffCapabilityRequirement('meter', 'approve'), {
		kind: 'CAPABILITY',
		permission: 'MANAGE_METERS'
	});
	assert.deepEqual(resolveStaffCapabilityRequirement('request', 'assign'), {
		kind: 'CAPABILITY',
		permission: 'MANAGE_REQUESTS'
	});
	assert.deepEqual(resolveStaffCapabilityRequirement('managedTenant', 'detail'), {
		kind: 'CAPABILITY',
		permission: 'VIEW_TENANTS'
	});
	assert.deepEqual(resolveStaffCapabilityRequirement('service', 'detail'), {
		kind: 'PROPERTY_ASSIGNMENT_ONLY'
	});
	assert.deepEqual(resolveStaffCapabilityRequirement('property', 'create'), { kind: 'DENY' });
});

test('staffHasPropertyReadCapability accepts any MVP operational capability', () => {
	assert.equal(staffHasPropertyReadCapability(['VIEW_ROOMS']), true);
	assert.equal(staffHasPropertyReadCapability(['MANAGE_REQUESTS']), true);
	assert.equal(staffHasPropertyReadCapability([]), false);
});

test('staffServiceReadCapability prefers VIEW_ROOMS then MANAGE_METERS', () => {
	assert.equal(staffServiceReadCapability(['MANAGE_METERS', 'VIEW_ROOMS']), 'VIEW_ROOMS');
	assert.equal(staffServiceReadCapability(['MANAGE_METERS']), 'MANAGE_METERS');
	assert.equal(staffServiceReadCapability(['VIEW_TENANTS']), null);
});

test('staffRequiresActiveTenancy only for managed tenant and tenancy reads', () => {
	assert.equal(staffRequiresActiveTenancy('managedTenant', 'detail'), true);
	assert.equal(staffRequiresActiveTenancy('tenancy', 'list'), true);
	assert.equal(staffRequiresActiveTenancy('meter', 'detail'), false);
});
