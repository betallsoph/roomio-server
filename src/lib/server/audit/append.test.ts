import assert from 'node:assert/strict';
import test from 'node:test';
import { auditEvents } from '$lib/server/db/schema';
import { AUDIT_ACTION_VERSION } from './actions.js';
import {
	auditActorFromUserActor,
	auditActorMachine,
	auditActorSystem,
	type AuditActorRef
} from './actors.js';
import { appendAudit, type AppendAuditInput, type AuditTx } from './append.js';
import { AuditValidationError, isAuditValidationError } from './metadata.js';

type InsertCapture = {
	table: unknown;
	row: Record<string, unknown>;
};

function createMockTx(returningId = 'audit-event-1') {
	const inserts: InsertCapture[] = [];
	const tx = {
		insert: (table: unknown) => ({
			values: (row: Record<string, unknown>) => ({
				returning: async () => {
					inserts.push({ table, row });
					return [{ id: returningId }];
				}
			})
		})
	} as unknown as AuditTx;

	return { tx, inserts };
}

const landlordActor = auditActorFromUserActor({
	kind: 'USER',
	userId: 'user-landlord',
	role: 'LANDLORD',
	landlordId: 'landlord-1'
});

const baseLandlordEvent: AppendAuditInput = {
	action: 'AUTH.LOGIN_SUCCESS',
	resourceType: 'User',
	resourceId: 'user-landlord',
	scope: 'LANDLORD',
	landlordId: 'landlord-1',
	requestId: 'req-1',
	metadata: { fromStatus: 'ACTIVE', toStatus: 'ACTIVE' }
};

test('appendAudit inserts landlord-scoped event on existing transaction', async () => {
	const { tx, inserts } = createMockTx('evt-landlord-1');
	const occurredAt = new Date('2026-07-28T10:00:00.000Z');

	const result = await appendAudit(tx, landlordActor, {
		...baseLandlordEvent,
		occurredAt
	});

	assert.equal(result.id, 'evt-landlord-1');
	assert.equal(inserts.length, 1);
	assert.equal(inserts[0].table, auditEvents);
	assert.deepEqual(inserts[0].row, {
		landlordId: 'landlord-1',
		actorType: 'USER',
		actorUserId: 'user-landlord',
		actorRole: 'LANDLORD',
		action: 'AUTH.LOGIN_SUCCESS',
		resourceType: 'User',
		resourceId: 'user-landlord',
		requestId: 'req-1',
		jobId: null,
		metadata: { fromStatus: 'ACTIVE', toStatus: 'ACTIVE' },
		metadataVersion: AUDIT_ACTION_VERSION,
		occurredAt
	});
});

test('appendAudit resolves landlordId from actor hint when event omits it', async () => {
	const { tx, inserts } = createMockTx();

	await appendAudit(tx, landlordActor, {
		...baseLandlordEvent,
		landlordId: undefined
	});

	assert.equal(inserts[0].row.landlordId, 'landlord-1');
});

test('appendAudit inserts platform-scoped event with landlordId null', async () => {
	const { tx, inserts } = createMockTx('evt-platform-1');
	const actor = auditActorSystem('MIGRATION');

	const result = await appendAudit(tx, actor, {
		action: 'PLATFORM.BACKFILL_EXECUTED',
		resourceType: 'PlatformConfig',
		resourceId: 'global',
		scope: 'PLATFORM',
		jobId: 'job-1'
	});

	assert.equal(result.id, 'evt-platform-1');
	assert.equal(inserts[0].row.landlordId, null);
	assert.equal(inserts[0].row.actorType, 'SYSTEM');
	assert.equal(inserts[0].row.actorUserId, null);
	assert.equal(inserts[0].row.actorRole, 'MIGRATION');
	assert.equal(inserts[0].row.jobId, 'job-1');
});

test('appendAudit accepts machine actor with null actorUserId', async () => {
	const { tx, inserts } = createMockTx();
	const actor = auditActorMachine('PAYMENT_WEBHOOK');

	await appendAudit(tx, actor, {
		action: 'PAYMENT.RECORDED',
		resourceType: 'PaymentTransaction',
		resourceId: 'pay-1',
		scope: 'LANDLORD',
		landlordId: 'landlord-1',
		requestId: 'req-webhook-1'
	});

	assert.equal(inserts[0].row.actorType, 'MACHINE');
	assert.equal(inserts[0].row.actorUserId, null);
	assert.equal(inserts[0].row.actorRole, 'PAYMENT_WEBHOOK');
});

test('appendAudit rejects USER actor without actorUserId', async () => {
	const { tx } = createMockTx();
	const actor: AuditActorRef = {
		actorType: 'USER',
		actorUserId: null,
		actorRole: 'LANDLORD'
	};

	await assert.rejects(
		() =>
			appendAudit(tx, actor, {
				...baseLandlordEvent
			}),
		(error: unknown) => {
			assert.ok(isAuditValidationError(error));
			assert.equal(error.code, 'MISSING_ACTOR_USER_ID');
			return true;
		}
	);
});

test('appendAudit rejects landlord scope without landlordId', async () => {
	const { tx } = createMockTx();
	const actor = auditActorFromUserActor({
		kind: 'USER',
		userId: 'user-super',
		role: 'SUPER_ADMIN'
	});

	await assert.rejects(
		() =>
			appendAudit(tx, actor, {
				action: 'AUTH.LOGIN_SUCCESS',
				resourceType: 'User',
				resourceId: 'user-super',
				scope: 'LANDLORD'
			}),
		(error: unknown) => {
			assert.ok(isAuditValidationError(error));
			assert.equal(error.code, 'MISSING_LANDLORD_ID');
			return true;
		}
	);
});

test('appendAudit rejects platform scope when landlordId is provided', async () => {
	const { tx } = createMockTx();

	await assert.rejects(
		() =>
			appendAudit(tx, auditActorSystem(), {
				action: 'PLATFORM.BACKFILL_EXECUTED',
				resourceType: 'PlatformConfig',
				resourceId: 'global',
				scope: 'PLATFORM',
				landlordId: 'landlord-1'
			}),
		(error: unknown) => {
			assert.ok(isAuditValidationError(error));
			assert.equal(error.code, 'INVALID_SCOPE');
			return true;
		}
	);
});

test('appendAudit rejects forbidden metadata keys', async () => {
	const { tx } = createMockTx();

	await assert.rejects(
		() =>
			appendAudit(tx, landlordActor, {
				...baseLandlordEvent,
				metadata: { accessToken: 'secret' }
			}),
		(error: unknown) => {
			assert.ok(error instanceof AuditValidationError);
			assert.equal(error.code, 'FORBIDDEN_METADATA_KEY');
			return true;
		}
	);
});

test('appendAudit rejects invalid action strings', async () => {
	const { tx } = createMockTx();

	await assert.rejects(
		() =>
			appendAudit(tx, landlordActor, {
				...baseLandlordEvent,
				action: 'NOT.A.REAL.ACTION' as AppendAuditInput['action']
			}),
		(error: unknown) => {
			assert.ok(isAuditValidationError(error));
			assert.equal(error.code, 'INVALID_ACTION');
			return true;
		}
	);
});
