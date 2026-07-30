import assert from 'node:assert/strict';
import test from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { pickSettingsWriteInput, toSettingsDto } from './settings.js';
import { toSupportContactTenantDto } from './support-contact.js';
import { SUPER_ADMIN_FORBIDDEN_KEYS } from './super-admin.js';

test('toSettingsDto never echoes encrypted PayOS credentials', () => {
	const dto = toSettingsDto({
		id: 'landlord-1',
		companyName: 'Fixture Co',
		bankName: 'VCB',
		bankCode: '970436',
		accountNumber: '123',
		accountName: 'FIXTURE',
		bankBranch: 'HCM',
		momoNumber: null,
		payosClientId: 'client',
		payosApiKeyEnc: 'cipher:secret',
		payosChecksumKeyEnc: 'cipher:checksum',
		payosConnectedAt: '2026-01-01T00:00:00.000Z',
		user: { name: 'A', email: 'a@fixture.test', phone: '0900000001' }
	});
	expectNoForbiddenKeys(dto);
	assert.equal('payosApiKeyEnc' in dto, false);
	assert.equal('payosChecksumKeyEnc' in dto, false);
	assert.equal(dto.payosConnected, true);
});

test('pickSettingsWriteInput ignores unknown mass-assignment keys', () => {
	const picked = pickSettingsWriteInput({
		companyName: 'Allowed',
		landlordId: 'foreign',
		role: 'SUPER_ADMIN',
		payosApiKeyEnc: 'stolen'
	});
	assert.deepEqual(picked, { companyName: 'Allowed' });
});

test('toSupportContactTenantDto exposes shareable fields only', () => {
	const dto = toSupportContactTenantDto({
		id: 'sc-1',
		category: 'repair',
		name: 'Repair Co',
		phone: '0900000091',
		secondaryPhone: null,
		company: 'Co',
		serviceArea: 'District 7',
		notes: 'internal',
		isPinned: true,
		isActive: true,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	});
	expectNoForbiddenKeys(dto);
	assert.equal('notes' in dto, false);
	assert.equal('isActive' in dto, false);
});

test('SUPER_ADMIN_FORBIDDEN_KEYS documents operational leak targets', () => {
	assert.ok(SUPER_ADMIN_FORBIDDEN_KEYS.includes('invoices'));
	assert.ok(SUPER_ADMIN_FORBIDDEN_KEYS.includes('rooms'));
});
