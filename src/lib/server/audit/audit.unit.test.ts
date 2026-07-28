import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_ACTION_VERSION, isAuditAction } from './actions.js';
import { decodeAuditCursor, encodeAuditCursor } from './query.js';
import { toAuditEventDto, type AuditEventDto } from './dto.js';
import { AuditValidationError } from './metadata.js';
import { validateAuditMetadata } from './metadata.js';

const PUBLIC_DTO_KEYS = [
	'id',
	'landlordId',
	'actorType',
	'actorUserId',
	'actorRole',
	'action',
	'resourceType',
	'resourceId',
	'requestId',
	'jobId',
	'metadata',
	'occurredAt'
] as const satisfies readonly (keyof AuditEventDto)[];

test('toAuditEventDto exposes only public allowlist fields', () => {
	const occurredAt = new Date('2026-07-28T10:00:00.000Z');
	const createdAt = new Date('2026-07-28T10:00:01.000Z');

	const dto = toAuditEventDto({
		id: 'evt-1',
		landlordId: 'landlord-1',
		actorType: 'USER',
		actorUserId: 'user-1',
		actorRole: 'LANDLORD',
		action: 'CONFIG.UPDATED',
		resourceType: 'LandlordProfile',
		resourceId: 'landlord-1',
		requestId: 'req-1',
		jobId: null,
		metadata: { settingKey: 'invoicePrefix', status: 'enabled' },
		metadataVersion: 99,
		occurredAt,
		createdAt
	});

	assert.deepEqual(Object.keys(dto).sort(), [...PUBLIC_DTO_KEYS].sort());
	assert.equal(dto.id, 'evt-1');
	assert.equal(dto.landlordId, 'landlord-1');
	assert.equal(dto.actorType, 'USER');
	assert.equal(dto.actorUserId, 'user-1');
	assert.equal(dto.actorRole, 'LANDLORD');
	assert.equal(dto.action, 'CONFIG.UPDATED');
	assert.equal(dto.occurredAt, occurredAt.toISOString());
	assert.deepEqual(dto.metadata, { settingKey: 'invoicePrefix', status: 'enabled' });
	assert.equal('metadataVersion' in dto, false);
	assert.equal('createdAt' in dto, false);
});

test('encodeAuditCursor / decodeAuditCursor round-trip', () => {
	const occurredAt = '2026-07-28T12:34:56.789Z';
	const id = 'evt-cursor-1';
	const encoded = encodeAuditCursor({ occurredAt, id });
	const decoded = decodeAuditCursor(encoded);

	assert.equal(decoded.id, id);
	assert.equal(decoded.occurredAt, occurredAt);
	assert.equal(decoded.occurredAtDate.toISOString(), occurredAt);
});

test('decodeAuditCursor rejects malformed opaque cursor', () => {
	assert.throws(() => decodeAuditCursor('not-valid-base64url'), AuditValidationError);
	assert.throws(() => decodeAuditCursor(''), AuditValidationError);
});

test('validateAuditMetadata accepts safe primitive metadata', () => {
	const sanitized = validateAuditMetadata(
		{
			invoiceId: 'inv-1',
			status: 'PAID',
			amount: '150000',
			nested: { previousStatus: 'DRAFT' }
		},
		AUDIT_ACTION_VERSION
	);
	assert.deepEqual(sanitized, {
		invoiceId: 'inv-1',
		status: 'PAID',
		amount: '150000',
		nested: { previousStatus: 'DRAFT' }
	});
});

test('validateAuditMetadata rejects forbidden key substrings', () => {
	assert.throws(
		() => validateAuditMetadata({ accessToken: 'leak' }, AUDIT_ACTION_VERSION),
		AuditValidationError
	);
	assert.throws(
		() => validateAuditMetadata({ rawBody: '{"secret":true}' }, AUDIT_ACTION_VERSION),
		AuditValidationError
	);
});

test('validateAuditMetadata rejects oversize payload', () => {
	const huge = 'x'.repeat(5_000);
	assert.throws(
		() => validateAuditMetadata({ note: huge }, AUDIT_ACTION_VERSION),
		AuditValidationError
	);
});

test('isAuditAction guards the versioned allowlist', () => {
	assert.equal(isAuditAction('AUTH.LOGIN_SUCCESS'), true);
	assert.equal(isAuditAction('CONFIG.UPDATED'), true);
	assert.equal(isAuditAction('NOT.A.REAL.ACTION'), false);
	assert.equal(isAuditAction(''), false);
});
