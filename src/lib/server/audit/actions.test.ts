import assert from 'node:assert/strict';
import test from 'node:test';

const { AUDIT_ACTIONS, AUDIT_ACTION_VERSION, isAuditAction } = await import('./actions.js');

const ACTION_PATTERN = /^[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*$/;

test('AUDIT_ACTION_VERSION is 1', () => {
	assert.equal(AUDIT_ACTION_VERSION, 1);
});

test('every catalog entry matches DOMAIN.ACTION pattern', () => {
	for (const action of AUDIT_ACTIONS) {
		assert.match(action, ACTION_PATTERN, `invalid action format: ${action}`);
	}
});

test('catalog has no duplicate entries', () => {
	const unique = new Set(AUDIT_ACTIONS);
	assert.equal(unique.size, AUDIT_ACTIONS.length);
});

test('isAuditAction accepts every allowlisted action', () => {
	for (const action of AUDIT_ACTIONS) {
		assert.equal(isAuditAction(action), true);
	}
});

test('isAuditAction rejects unknown or malformed values', () => {
	assert.equal(isAuditAction(''), false);
	assert.equal(isAuditAction('AUTH.LOGIN'), false);
	assert.equal(isAuditAction('auth.login_success'), false);
	assert.equal(isAuditAction('AUTH.UNKNOWN_ACTION'), false);
	assert.equal(isAuditAction('NOT_IN_CATALOG.CREATED'), false);
});
