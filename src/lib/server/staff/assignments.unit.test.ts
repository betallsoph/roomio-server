import assert from 'node:assert/strict';
import test from 'node:test';
import {
	InvalidStaffPermissionError,
	StaffResourceNotFoundError,
	assignStaffProperty,
	assignStaffPropertyTx,
	grantStaffPermission,
	revokeStaffPropertyTx,
	revokeStaffPermissionTx
} from './assignments.js';
import type { LandlordActor } from '$lib/server/authorization/actor';
import { toStaffPermissionDto, toStaffPropertyAssignmentDto } from './dto.js';
import { resolveLandlordActorFromRequest } from './landlord-request.js';

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

test('DTO allowlist omits assignedByUserId and grantedByUserId', () => {
	const assignment = toStaffPropertyAssignmentDto({
		id: 'a1',
		staffId: 's1',
		propertyId: 'p1',
		createdAt: new Date('2026-01-01T00:00:00Z'),
		revokedAt: null,
		assignedByUserId: 'secret-user'
	} as never);
	assert.equal('assignedByUserId' in assignment, false);

	const permission = toStaffPermissionDto({
		id: 'perm1',
		staffId: 's1',
		permission: 'VIEW_ROOMS',
		createdAt: new Date('2026-01-01T00:00:00Z'),
		revokedAt: null,
		grantedByUserId: 'secret-user'
	} as never);
	assert.equal('grantedByUserId' in permission, false);
});

test('resolveLandlordActorFromRequest rejects null actor even with landlord-shaped session absent', async () => {
	const result = resolveLandlordActorFromRequest({ actor: null });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.response.status, 401);
});

test('resolveLandlordActorFromRequest rejects SUPER_ADMIN actor', async () => {
	const result = resolveLandlordActorFromRequest({
		actor: { kind: 'USER', userId: 'admin', role: 'SUPER_ADMIN' }
	});
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.response.status, 403);
});

test('resolveLandlordActorFromRequest rejects STAFF actor', async () => {
	const result = resolveLandlordActorFromRequest({
		actor: {
			kind: 'USER',
			userId: 's',
			role: 'STAFF',
			staffId: 'sid',
			landlordId: 'lid',
			propertyIds: [],
			permissions: []
		}
	});
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.response.status, 403);
});

test('concurrent-style grant: ON CONFLICT path returns changed=false without second audit insert', async () => {
	const existing = {
		id: 'asg-1',
		staffId: 's1',
		propertyId: 'p1',
		assignedByUserId: 'u',
		createdAt: new Date(),
		revokedAt: null
	};
	const tx = {
		query: {
			staffProfiles: {
				findFirst: async () => ({ id: 's1', landlordId: 'landlord-a', userId: 'su' })
			},
			properties: {
				findFirst: async () => ({ id: 'p1', landlordId: 'landlord-a' })
			},
			staffPropertyAssignments: {
				findFirst: async () => existing
			}
		},
		insert() {
			return {
				values() {
					return {
						onConflictDoNothing() {
							return {
								returning: async () => []
							};
						}
					};
				}
			};
		}
	} as never;

	// Patch appendAudit is not called when insert returns empty — verify via changed flag only.
	const result = await assignStaffPropertyTx(tx, landlordA, { staffId: 's1', propertyId: 'p1' });
	assert.equal(result.changed, false);
	assert.equal(result.value.id, 'asg-1');
});

test('concurrent-style revoke: conditional UPDATE with zero rows → changed=false', async () => {
	const tx = {
		query: {
			staffProfiles: {
				findFirst: async () => ({ id: 's1', landlordId: 'landlord-a', userId: 'su' })
			},
			properties: {
				findFirst: async () => ({ id: 'p1', landlordId: 'landlord-a' })
			}
		},
		update() {
			return {
				set() {
					return {
						where() {
							return {
								returning: async () => []
							};
						}
					};
				}
			};
		}
	} as never;

	const result = await revokeStaffPropertyTx(tx, landlordA, { staffId: 's1', propertyId: 'p1' });
	assert.equal(result.changed, false);
	assert.equal(result.value, null);
});

test('concurrent-style permission revoke: second caller gets changed=false', async () => {
	const tx = {
		query: {
			staffProfiles: {
				findFirst: async () => ({ id: 's1', landlordId: 'landlord-a', userId: 'su' })
			}
		},
		update() {
			return {
				set() {
					return {
						where() {
							return {
								returning: async () => []
							};
						}
					};
				}
			};
		}
	} as never;

	const result = await revokeStaffPermissionTx(tx, landlordA, {
		staffId: 's1',
		permission: 'VIEW_ROOMS'
	});
	assert.equal(result.changed, false);
	assert.equal(result.value, null);
});
