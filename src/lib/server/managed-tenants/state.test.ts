import assert from 'node:assert/strict';
import test from 'node:test';
import {
	normalizeCreateManagedTenantInput,
	normalizeEmailSnapshot,
	normalizePhoneSnapshot,
	toManagedTenantSummaryDto
} from './state.js';

test('normalizeEmailSnapshot trims and lowercases without matching users', () => {
	assert.equal(normalizeEmailSnapshot('  Tenant@Example.COM '), 'tenant@example.com');
	assert.equal(normalizeEmailSnapshot(''), null);
	assert.equal(normalizeEmailSnapshot(null), null);
});

test('normalizePhoneSnapshot keeps digits for display only', () => {
	assert.equal(normalizePhoneSnapshot(' +84 901 234 567 '), '+84901234567');
	assert.equal(normalizePhoneSnapshot('0901234567'), '0901234567');
});

test('normalizeCreateManagedTenantInput requires displayName', () => {
	assert.throws(
		() => normalizeCreateManagedTenantInput({ displayName: '  ' }),
		(error: unknown) => {
			assert.equal((error as { code?: string }).code, 'DISPLAY_NAME_REQUIRED');
			return true;
		}
	);
});

test('toManagedTenantSummaryDto exposes tenantId alias for ManagedTenant.id', () => {
	const dto = toManagedTenantSummaryDto({
		id: 'mt-1',
		landlordId: 'landlord-1',
		displayName: 'Lan',
		emailSnapshot: 'lan@example.com',
		phoneSnapshot: '0900000000',
		claimedByUserId: null,
		claimVersion: 0,
		status: 'ACTIVE',
		createdAt: new Date('2026-07-01T00:00:00.000Z')
	});
	assert.equal(dto.id, 'mt-1');
	assert.equal(dto.tenantId, 'mt-1');
	assert.equal(dto.isClaimed, false);
});
