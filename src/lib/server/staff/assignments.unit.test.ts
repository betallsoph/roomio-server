import assert from 'node:assert/strict';
import test from 'node:test';
import {
	InvalidStaffPermissionError,
	StaffResourceNotFoundError,
	assignStaffProperty,
	grantStaffPermission
} from './assignments.js';
import type { LandlordActor } from '$lib/server/authorization/actor';

const landlordA: LandlordActor = {
	kind: 'USER',
	userId: 'landlord-user-a',
	role: 'LANDLORD',
	landlordId: 'landlord-a'
};

function createNotFoundConn() {
	const tx = {
		query: {
			staffProfiles: {
				findFirst: async () => null
			},
			properties: {
				findFirst: async () => null
			}
		}
	};
	return {
		transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)
	} as never;
}

test('grantStaffPermission rejects unknown permission with 422-class error', async () => {
	await assert.rejects(
		() =>
			grantStaffPermission(createNotFoundConn(), landlordA, { staffId: 's1', permission: 'NOPE' }),
		(err: unknown) => {
			assert.ok(err instanceof InvalidStaffPermissionError);
			assert.equal(err.status, 422);
			return true;
		}
	);
});

test('grantStaffPermission rejects wildcard permission', async () => {
	await assert.rejects(
		() => grantStaffPermission(createNotFoundConn(), landlordA, { staffId: 's1', permission: '*' }),
		(err: unknown) => err instanceof InvalidStaffPermissionError
	);
});

test('assignStaffProperty surfaces 404 when staff is not owned by landlord', async () => {
	await assert.rejects(
		() =>
			assignStaffProperty(createNotFoundConn(), landlordA, {
				staffId: 'foreign-staff',
				propertyId: 'property-a1'
			}),
		(err: unknown) => {
			assert.ok(err instanceof StaffResourceNotFoundError);
			assert.equal(err.status, 404);
			return true;
		}
	);
});
