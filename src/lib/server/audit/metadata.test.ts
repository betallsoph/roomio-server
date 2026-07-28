import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_ACTION_VERSION } from './actions.js';
import {
	AUDIT_METADATA_MAX_BYTES,
	AUDIT_METADATA_MAX_DEPTH,
	AUDIT_METADATA_MAX_KEYS,
	isAuditValidationError,
	validateAuditMetadata
} from './metadata.js';

test('validateAuditMetadata accepts safe primitives and nested IDs/status', () => {
	const result = validateAuditMetadata(
		{
			fromStatus: 'DRAFT',
			toStatus: 'ISSUED',
			invoiceId: 'inv-1',
			amount: '1500000',
			context: {
				tenancyId: 'tenancy-1',
				managedTenantId: 'managed-tenant-1'
			}
		},
		AUDIT_ACTION_VERSION
	);

	assert.deepEqual(result, {
		fromStatus: 'DRAFT',
		toStatus: 'ISSUED',
		invoiceId: 'inv-1',
		amount: '1500000',
		context: {
			tenancyId: 'tenancy-1',
			managedTenantId: 'managed-tenant-1'
		}
	});
});

test('validateAuditMetadata returns empty object for undefined/null input', () => {
	assert.deepEqual(validateAuditMetadata(undefined, AUDIT_ACTION_VERSION), {});
	assert.deepEqual(validateAuditMetadata(null, AUDIT_ACTION_VERSION), {});
});

test('validateAuditMetadata rejects unsupported metadata version', () => {
	assert.throws(
		() => validateAuditMetadata({}, AUDIT_ACTION_VERSION + 1),
		(error: unknown) => {
			assert.ok(isAuditValidationError(error));
			assert.equal(error.code, 'UNSUPPORTED_METADATA_VERSION');
			return true;
		}
	);
});

test('validateAuditMetadata rejects forbidden keys by case-insensitive substring', () => {
	for (const key of ['passwordHash', 'accessToken', 'userEmail', 'contactName', 'customFieldId']) {
		assert.throws(
			() => validateAuditMetadata({ [key]: 'x' }, AUDIT_ACTION_VERSION),
			(error: unknown) => {
				assert.ok(isAuditValidationError(error));
				assert.equal(error.code, 'FORBIDDEN_METADATA_KEY');
				return true;
			}
		);
	}
});

test('validateAuditMetadata rejects nesting deeper than max depth', () => {
	const tooDeep: Record<string, unknown> = { a: { b: { c: { d: 'x' } } } };
	assert.throws(
		() => validateAuditMetadata(tooDeep, AUDIT_ACTION_VERSION),
		(error: unknown) => {
			assert.ok(isAuditValidationError(error));
			assert.equal(error.code, 'METADATA_TOO_DEEP');
			return true;
		}
	);
	assert.equal(AUDIT_METADATA_MAX_DEPTH, 2);
});

test('validateAuditMetadata rejects too many keys per object', () => {
	const input: Record<string, string> = {};
	for (let i = 0; i < AUDIT_METADATA_MAX_KEYS + 1; i++) {
		input[`field${i}`] = 'ok';
	}
	assert.throws(
		() => validateAuditMetadata(input, AUDIT_ACTION_VERSION),
		(error: unknown) => {
			assert.ok(isAuditValidationError(error));
			assert.equal(error.code, 'METADATA_TOO_MANY_KEYS');
			return true;
		}
	);
});

test('validateAuditMetadata rejects serialized payload larger than max bytes', () => {
	assert.ok(AUDIT_METADATA_MAX_BYTES > 0);
	const input: Record<string, string> = {};
	for (let i = 0; i < AUDIT_METADATA_MAX_KEYS; i++) {
		input[`part${i}`] = 'x'.repeat(220);
	}
	assert.throws(
		() => validateAuditMetadata(input, AUDIT_ACTION_VERSION),
		(error: unknown) => {
			assert.ok(isAuditValidationError(error));
			assert.equal(error.code, 'METADATA_TOO_LARGE');
			return true;
		}
	);
});
