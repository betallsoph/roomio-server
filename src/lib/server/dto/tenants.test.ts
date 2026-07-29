import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { toTenantSummaryDto } from './tenants.js';

const poisonedUser = {
	id: 'user-1',
	name: 'Tenant',
	email: 't@example.com',
	phone: '0900000000',
	isActive: true,
	passwordHash: 'leaked',
	apiKey: 'leaked'
};

const poisonedPaymentAccount = {
	id: 'pa-1',
	name: 'Main',
	provider: 'vietqr',
	isDefault: true,
	isActive: true,
	bankName: 'VCB',
	bankCode: '970436',
	accountNumber: '123',
	accountName: 'Owner',
	bankBranch: null,
	momoNumber: null,
	payosClientId: null,
	payosConnectedAt: null,
	createdAt: new Date('2026-01-01'),
	updatedAt: new Date('2026-01-01'),
	payosApiKeyEnc: 'secret',
	checksumKey: 'secret'
};

test('toTenantSummaryDto strips nested secrets from rooms and user', () => {
	const dto = toTenantSummaryDto({
		id: 'tenant-1',
		userId: 'user-1',
		telegramUserId: null,
		idNumber: '001',
		idFrontImage: null,
		idBackImage: null,
		vehicleImage: null,
		checkInImage: null,
		moveInDate: '2026-01-01',
		deposit: 1000000,
		notes: null,
		user: poisonedUser,
		rooms: [
			{
				id: 'room-1',
				propertyId: 'prop-1',
				blockId: null,
				roomNumber: '101',
				roomCode: null,
				roomType: 'standard',
				floor: 1,
				status: 'paid',
				monthlyRent: 3000000,
				area: 20,
				debtAmount: 0,
				paymentAccountId: 'pa-1',
				tenantId: 'tenant-1',
				currentManagedTenantId: null,
				property: {
					id: 'prop-1',
					landlordId: 'landlord-1',
					name: 'Building',
					shortName: 'B',
					address: 'Addr',
					rentalType: 'MOTEL',
					operatingModel: 'OWNED',
					createdAt: new Date('2026-01-01')
				},
				block: { id: 'block-1', propertyId: 'prop-1', name: 'A' },
				paymentAccount: poisonedPaymentAccount
			}
		]
	});

	expectNoForbiddenKeys(dto);
	assert.equal(dto.rooms.length, 1);
	assert.equal(dto.user.name, 'Tenant');
});
