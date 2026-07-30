import assert from 'node:assert/strict';
import test from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { toPaymentAccountDto } from './payment-account.js';

const PUBLIC_PAYMENT_ACCOUNT_KEYS = [
	'id',
	'landlordId',
	'name',
	'provider',
	'isDefault',
	'isActive',
	'bankName',
	'bankCode',
	'accountNumber',
	'accountName',
	'bankBranch',
	'momoNumber',
	'payosClientId',
	'payosConnected',
	'payosConnectedAt',
	'createdAt',
	'updatedAt'
] as const;

test('toPaymentAccountDto exposes only public allowlist fields', () => {
	const createdAt = new Date('2026-07-28T10:00:00.000Z');
	const updatedAt = new Date('2026-07-28T10:00:01.000Z');

	const dto = toPaymentAccountDto({
		id: 'acc-1',
		landlordId: 'landlord-1',
		name: 'Main account',
		provider: 'payos',
		isDefault: true,
		isActive: true,
		bankName: 'VCB',
		bankCode: '970436',
		accountNumber: '1234567890',
		accountName: 'NGUYEN VAN A',
		bankBranch: 'HN',
		momoNumber: null,
		payosClientId: 'client-1',
		payosApiKeyEnc: 'cipher:api-key',
		payosChecksumKeyEnc: 'cipher:checksum',
		payosConnectedAt: createdAt,
		createdAt,
		updatedAt
	});

	assert.deepEqual(Object.keys(dto).sort(), [...PUBLIC_PAYMENT_ACCOUNT_KEYS].sort());
	expectNoForbiddenKeys(dto);
	assert.equal('payosApiKeyEnc' in dto, false);
	assert.equal('payosChecksumKeyEnc' in dto, false);
});

test('toPaymentAccountDto derives payosConnected from payosConnectedAt when secrets omitted', () => {
	const createdAt = new Date('2026-07-28T10:00:00.000Z');
	const dto = toPaymentAccountDto({
		id: 'acc-safe',
		landlordId: 'landlord-1',
		name: 'Safe projection',
		provider: 'payos',
		isDefault: true,
		isActive: true,
		bankName: 'VCB',
		bankCode: '970436',
		accountNumber: '1234567890',
		accountName: 'NGUYEN VAN A',
		bankBranch: null,
		momoNumber: null,
		payosClientId: 'client-1',
		payosConnectedAt: createdAt,
		createdAt,
		updatedAt: createdAt
	});

	assert.equal(dto.payosConnected, true);
	expectNoForbiddenKeys(dto);
});
