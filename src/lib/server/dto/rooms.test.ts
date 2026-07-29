import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import {
	toMeterReadingDto,
	toPaymentAccountDto,
	toPublicUserDto,
	toRoomDto,
	toTenantProfileDto,
	toTenantRoomSummaryDto
} from './rooms.js';

const poisonedUser = {
	id: 'user-1',
	name: 'Tenant',
	email: 't@example.com',
	phone: '0900000000',
	isActive: true,
	passwordHash: 'leaked',
	sessionSecret: 'leaked'
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
	payosChecksumKeyEnc: 'secret'
};

test('toPublicUserDto strips forbidden user fields', () => {
	const dto = toPublicUserDto(poisonedUser);
	assert.ok(dto);
	expectNoForbiddenKeys(dto);
	assert.equal('passwordHash' in dto, false);
});

test('toPaymentAccountDto strips PayOS secrets', () => {
	const dto = toPaymentAccountDto(poisonedPaymentAccount);
	assert.ok(dto);
	expectNoForbiddenKeys(dto);
	assert.equal('payosApiKeyEnc' in dto, false);
	assert.equal('payosChecksumKeyEnc' in dto, false);
});

test('toRoomDto never leaks nested secrets', () => {
	const dto = toRoomDto({
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
		block: { id: 'block-1', propertyId: 'prop-1', name: 'A' },
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
		paymentAccount: poisonedPaymentAccount,
		tenant: {
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
			user: poisonedUser
		},
		services: [
			{
				id: 'rsc-1',
				roomId: 'room-1',
				serviceId: 'svc-1',
				customRate: null,
				quantity: 1,
				service: {
					id: 'svc-1',
					landlordId: 'landlord-1',
					name: 'Điện',
					type: 'METERED',
					defaultRate: 3500,
					isActive: true
				}
			}
		],
		assets: [
			{
				id: 'asset-1',
				roomId: 'room-1',
				name: 'AC',
				code: null,
				status: 'good',
				imageUrl: null,
				notes: null
			}
		],
		meterReadings: [
			{
				id: 'mr-1',
				roomId: 'room-1',
				serviceId: 'svc-1',
				month: '2026-01',
				prevValue: 0,
				submittedValue: null,
				currValue: 100,
				recordedAt: '2026-01-01',
				photoUrl: null,
				ocrParsedValue: null,
				status: 'approved',
				submittedBy: 'LANDLORD',
				isAnomalous: false,
				managedTenantId: null,
				tenancyId: null,
				ocrRawText: 'debug leak'
			}
		]
	});

	expectNoForbiddenKeys(dto);
	assert.equal('ocrRawText' in dto.meterReadings[0], false);
});

test('toTenantProfileDto and toTenantRoomSummaryDto are safe', () => {
	const profile = toTenantProfileDto({
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
		user: poisonedUser
	});
	assert.ok(profile);
	expectNoForbiddenKeys(profile);

	const roomSummary = toTenantRoomSummaryDto({
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
		paymentAccount: poisonedPaymentAccount
	});
	expectNoForbiddenKeys(roomSummary);
});

test('toMeterReadingDto omits ocrRawText', () => {
	const dto = toMeterReadingDto({
		id: 'mr-1',
		roomId: 'room-1',
		serviceId: 'svc-1',
		month: '2026-01',
		prevValue: 0,
		submittedValue: null,
		currValue: 100,
		recordedAt: '2026-01-01',
		photoUrl: null,
		ocrParsedValue: null,
		status: 'approved',
		submittedBy: 'LANDLORD',
		isAnomalous: false,
		managedTenantId: null,
		tenancyId: null,
		ocrRawText: 'leak'
	});
	expectNoForbiddenKeys(dto);
	assert.equal('ocrRawText' in dto, false);
});
