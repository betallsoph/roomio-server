import assert from 'node:assert/strict';
import test from 'node:test';
import type { StaffActor } from './actor.js';
import { isStaffCapability, staffHasCapability, staffHasPropertyAccess } from './staff-scope.js';

const staff: StaffActor = {
	kind: 'USER',
	userId: 'u1',
	role: 'STAFF',
	staffId: 's1',
	landlordId: 'l1',
	propertyIds: ['p1'],
	permissions: ['VIEW_ROOMS', 'MANAGE_METERS']
};

test('isStaffCapability accepts known permissions and rejects unknown and wildcard', () => {
	assert.equal(isStaffCapability('VIEW_ROOMS'), true);
	assert.equal(isStaffCapability('MANAGE_METERS'), true);
	assert.equal(isStaffCapability('NOT_REAL'), false);
	assert.equal(isStaffCapability('*'), false);
});

test('staffHasPropertyAccess and staffHasCapability reflect actor slices', () => {
	assert.equal(staffHasPropertyAccess(staff, 'p1'), true);
	assert.equal(staffHasPropertyAccess(staff, 'p2'), false);
	assert.equal(staffHasCapability(staff, 'VIEW_ROOMS'), true);
	assert.equal(staffHasCapability(staff, 'MANAGE_REQUESTS'), false);
});
