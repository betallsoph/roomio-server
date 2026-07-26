import assert from 'node:assert/strict';
import test from 'node:test';
import { resetEnvForTests } from './env.js';

resetEnvForTests({
	NODE_ENV: 'test',
	DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio_test'
});

const { paymentAccountConfigurationStatus } = await import('./payment-accounts.js');

test('legacy demo bank account is never treated as configured', () => {
	assert.equal(
		paymentAccountConfigurationStatus({
			provider: 'vietqr',
			bankCode: 'VCB',
			accountNumber: '1234567890',
			accountName: 'NGUYEN VAN HAU',
			payosClientId: null,
			payosApiKeyEnc: null,
			payosChecksumKeyEnc: null
		}),
		'NOT_CONFIGURED'
	);
});

test('real bank details are active without platform PayOS credentials', () => {
	assert.equal(
		paymentAccountConfigurationStatus({
			provider: 'vietqr',
			bankCode: 'ACB',
			accountNumber: '987654321',
			accountName: 'ROOMIO TEST OWNER',
			payosClientId: null,
			payosApiKeyEnc: null,
			payosChecksumKeyEnc: null
		}),
		'ACTIVE'
	);
});

test('bank details without a bank code are not payment-ready', () => {
	assert.equal(
		paymentAccountConfigurationStatus({
			provider: 'vietqr',
			bankCode: '',
			accountNumber: '987654321',
			accountName: 'ROOMIO TEST OWNER',
			payosClientId: null,
			payosApiKeyEnc: null,
			payosChecksumKeyEnc: null
		}),
		'NOT_CONFIGURED'
	);
});

test('per-landlord PayOS only needs encrypted account keys and PAYOS_ENC_KEY', () => {
	resetEnvForTests({
		NODE_ENV: 'test',
		DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio_test',
		PAYOS_ENC_KEY: 'per-landlord-encryption-key-at-least-32-characters'
	});
	assert.equal(
		paymentAccountConfigurationStatus({
			provider: 'payos',
			bankCode: '',
			accountNumber: '',
			accountName: '',
			payosClientId: 'landlord-client',
			payosApiKeyEnc: 'encrypted-api-key',
			payosChecksumKeyEnc: 'encrypted-checksum-key'
		}),
		'ACTIVE'
	);
});
