import assert from 'node:assert/strict';
import test from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { toContractDto } from './contract.js';

const CONTRACT_BASE_KEYS = [
	'id',
	'tenantId',
	'roomId',
	'tenancyId',
	'managedTenantId',
	'startDate',
	'endDate',
	'monthlyRent',
	'deposit',
	'fileUrl',
	'notes',
	'status',
	'paymentAccountId',
	'createdAt'
] as const;

test('toContractDto exposes nested summaries without credential fields', () => {
	const dto = toContractDto({
		id: 'contract-1',
		tenantId: 'tenant-1',
		roomId: 'room-1',
		tenancyId: 'tenancy-1',
		managedTenantId: 'managed-1',
		startDate: '2026-07-01',
		endDate: '2027-07-01',
		monthlyRent: 3_000_000,
		deposit: 3_000_000,
		fileUrl: null,
		notes: null,
		status: 'active',
		paymentAccountId: 'acc-1',
		createdAt: new Date('2026-07-01T00:00:00.000Z'),
		tenant: {
			id: 'tenant-1',
			userId: 'user-1',
			telegramUserId: null,
			idNumber: null,
			idFrontImage: null,
			idBackImage: null,
			vehicleImage: null,
			checkInImage: null,
			moveInDate: null,
			deposit: null,
			notes: null,
			user: { name: 'Tenant A', phone: '0900000001' }
		},
		room: {
			id: 'room-1',
			propertyId: 'prop-1',
			blockId: null,
			roomNumber: '101',
			roomCode: null,
			roomType: 'standard',
			floor: 1,
			status: 'paid',
			monthlyRent: 3_000_000,
			area: 20,
			debtAmount: 0,
			paymentAccountId: 'acc-1',
			tenantId: 'tenant-1',
			currentManagedTenantId: null,
			property: { name: 'Building A', shortName: 'A' },
			paymentAccount: {
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
				bankBranch: null,
				momoNumber: null,
				payosClientId: 'client-1',
				payosApiKeyEnc: 'cipher:api-key',
				payosChecksumKeyEnc: 'cipher:checksum',
				payosConnectedAt: null,
				createdAt: new Date('2026-07-28T10:00:00.000Z'),
				updatedAt: new Date('2026-07-28T10:00:01.000Z')
			}
		},
		paymentAccount: {
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
			bankBranch: null,
			momoNumber: null,
			payosClientId: 'client-1',
			payosApiKeyEnc: 'cipher:api-key',
			payosChecksumKeyEnc: 'cipher:checksum',
			payosConnectedAt: null,
			createdAt: new Date('2026-07-28T10:00:00.000Z'),
			updatedAt: new Date('2026-07-28T10:00:01.000Z')
		}
	});

	assert.deepEqual(
		Object.keys(dto).sort(),
		[...CONTRACT_BASE_KEYS, 'tenant', 'room', 'paymentAccount'].sort()
	);
	expectNoForbiddenKeys(dto);
	assert.deepEqual(Object.keys(dto.tenant!.user).sort(), ['name', 'phone']);
});
