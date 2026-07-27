import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SecurityIntegrationDisabledError,
	assertSecurityIntegrationEnabled,
	createSecurityRunId,
	getSecurityIntegrationSkipReason,
	isSecurityIntegrationEnabled
} from './test-db.js';

const ENV_KEYS = ['DATABASE_URL', 'SECURITY_INTEGRATION'] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test('isSecurityIntegrationEnabled is false without SECURITY_INTEGRATION=1', () => {
	withEnv(
		{
			DATABASE_URL: 'postgres://roomio:ci_test_password@localhost:5432/roomio_test',
			SECURITY_INTEGRATION: undefined
		},
		() => {
			assert.equal(isSecurityIntegrationEnabled(), false);
			assert.match(getSecurityIntegrationSkipReason() ?? '', /SECURITY_INTEGRATION=1/);
		}
	);
});

test('isSecurityIntegrationEnabled is false without postgres DATABASE_URL', () => {
	withEnv(
		{
			DATABASE_URL: undefined,
			SECURITY_INTEGRATION: '1'
		},
		() => {
			assert.equal(isSecurityIntegrationEnabled(), false);
			assert.match(getSecurityIntegrationSkipReason() ?? '', /DATABASE_URL/);
		}
	);
});

test('isSecurityIntegrationEnabled rejects non-disposable database names', () => {
	withEnv(
		{
			DATABASE_URL: 'postgres://roomio:secret@db.prod.example:5432/roomio',
			SECURITY_INTEGRATION: '1'
		},
		() => {
			assert.equal(isSecurityIntegrationEnabled(), false);
			assert.match(getSecurityIntegrationSkipReason() ?? '', /disposable|test|security/i);
		}
	);
});

test('isSecurityIntegrationEnabled accepts CI test database URL', () => {
	withEnv(
		{
			DATABASE_URL: 'postgres://roomio:ci_test_password@localhost:5432/roomio_test',
			SECURITY_INTEGRATION: '1'
		},
		() => {
			assert.equal(isSecurityIntegrationEnabled(), true);
			assert.equal(getSecurityIntegrationSkipReason(), undefined);
		}
	);
});

test('assertSecurityIntegrationEnabled throws SecurityIntegrationDisabledError', () => {
	withEnv(
		{
			DATABASE_URL: 'postgres://roomio:ci_test_password@localhost:5432/roomio_test',
			SECURITY_INTEGRATION: undefined
		},
		() => {
			assert.throws(() => assertSecurityIntegrationEnabled(), SecurityIntegrationDisabledError);
		}
	);
});

test('createSecurityRunId returns unique sec_ prefixed ids', () => {
	const a = createSecurityRunId();
	const b = createSecurityRunId();
	assert.match(a, /^sec_[a-z0-9]+_[a-z0-9]+$/);
	assert.notEqual(a, b);
});
