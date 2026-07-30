import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import {
	toTenantSummaryForLandlordDto,
	toTenantSummaryForStaffDto,
	toTenantSelfDto
} from './managed-tenant-directory.js';

test('landlord tenant summary omits server-only fields', () => {
	const dto = toTenantSummaryForLandlordDto({
		id: 'mt-1',
		displayName: 'Nguyen Van A',
		emailSnapshot: 'a@example.com',
		phoneSnapshot: '0900000000',
		claimedByUserId: 'user-1',
		createdAt: new Date('2026-01-01'),
		activeTenancy: {
			tenancyId: 'ten-1',
			propertyId: 'prop-1',
			roomId: 'room-1',
			roomLabel: '101',
			startDate: '2026-01-01'
		}
	});

	expectNoForbiddenKeys(dto);
	assert.equal(dto.tenantId, 'mt-1');
	assert.equal(dto.isClaimed, true);
});

test('staff tenant summary hides email and landlord-only counts', () => {
	const dto = toTenantSummaryForStaffDto({
		id: 'mt-1',
		displayName: 'Nguyen Van A',
		phoneSnapshot: '0900000000',
		activeTenancy: {
			tenancyId: 'ten-1',
			propertyId: 'prop-1',
			roomId: 'room-1',
			roomLabel: '101',
			startDate: '2026-01-01'
		}
	});

	expectNoForbiddenKeys(dto);
	assert.equal('emailSnapshot' in dto, false);
	assert.equal('isClaimed' in dto, false);
});

test('tenant self dto separates identity from managed tenants', () => {
	const dto = toTenantSelfDto({
		user: {
			id: 'user-1',
			name: 'Tenant',
			email: 't@example.com',
			phone: '0900000001'
		},
		managedTenants: [
			{
				id: 'mt-1',
				displayName: 'Tenant at A',
				landlordId: 'landlord-1',
				activeTenancies: []
			}
		]
	});

	expectNoForbiddenKeys(dto);
	assert.equal(dto.managedTenants[0]?.tenantId, 'mt-1');
});
