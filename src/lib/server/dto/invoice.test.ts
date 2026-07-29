import assert from 'node:assert/strict';
import test from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { toBulkInvoicePrepRoomDto, toInvoiceDto } from './invoice.js';

const INVOICE_BASE_KEYS = [
	'id',
	'roomId',
	'roomNumber',
	'tenantName',
	'tenantPhone',
	'month',
	'rentAmount',
	'totalAmount',
	'dueDate',
	'paidDate',
	'status',
	'paidAmount',
	'paymentProofImage',
	'paymentMethod',
	'paymentProvider',
	'paymentAccountId',
	'payosOrderCode',
	'payosPaymentLinkId',
	'payosCheckoutUrl',
	'payosQrCode',
	'payosStatus',
	'createdAt',
	'notes',
	'managedTenantId',
	'tenancyId'
] as const;

test('toInvoiceDto strips nested secrets and raw row spreads', () => {
	const dto = toInvoiceDto({
		id: 'INV-202607-1234',
		roomId: 'room-1',
		roomNumber: '101',
		tenantName: 'Tenant A',
		tenantPhone: '0900000001',
		month: '2026-07',
		rentAmount: 3_000_000,
		totalAmount: 3_500_000,
		dueDate: '2026-07-10',
		paidDate: null,
		status: 'pending',
		paidAmount: 0,
		paymentProofImage: null,
		paymentMethod: null,
		paymentProvider: null,
		paymentAccountId: 'acc-1',
		payosOrderCode: null,
		payosPaymentLinkId: null,
		payosCheckoutUrl: null,
		payosQrCode: null,
		payosStatus: null,
		createdAt: '2026-07-01',
		notes: null,
		managedTenantId: null,
		tenancyId: null,
		items: [
			{
				id: 'item-1',
				invoiceId: 'INV-202607-1234',
				name: 'Tiền phòng',
				amount: 3_000_000,
				details: 'July rent'
			}
		],
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
			payosConnectedAt: new Date('2026-07-28T10:00:00.000Z'),
			createdAt: new Date('2026-07-28T10:00:00.000Z'),
			updatedAt: new Date('2026-07-28T10:00:01.000Z')
		},
		room: {
			id: 'room-1',
			propertyId: 'prop-1',
			blockId: null,
			roomNumber: '101',
			roomCode: null,
			roomType: 'standard',
			floor: 1,
			status: 'debt',
			monthlyRent: 3_000_000,
			area: 20,
			debtAmount: 3_500_000,
			paymentAccountId: 'acc-1',
			tenantId: 'tenant-1',
			currentManagedTenantId: null,
			property: {
				id: 'prop-1',
				landlordId: 'landlord-1',
				name: 'Building A',
				shortName: 'A',
				address: '1 Main St',
				rentalType: 'APARTMENT',
				operatingModel: 'OWNED',
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				landlord: {
					id: 'landlord-1',
					userId: 'user-1',
					payosApiKeyEnc: 'cipher:landlord-key',
					payosChecksumKeyEnc: 'cipher:landlord-checksum'
				} as { id: string } & Record<string, unknown>
			},
			block: null
		}
	});

	assert.deepEqual(
		Object.keys(dto).sort(),
		[...INVOICE_BASE_KEYS, 'items', 'paymentAccount', 'room'].sort()
	);
	expectNoForbiddenKeys(dto);
	assert.equal(dto.room?.property.landlord?.id, 'landlord-1');
	assert.equal('payosApiKeyEnc' in (dto.paymentAccount ?? {}), false);
	assert.equal('userId' in (dto.room?.property.landlord ?? {}), false);
});

test('toBulkInvoicePrepRoomDto never exposes payment account credentials', () => {
	const dto = toBulkInvoicePrepRoomDto({
		id: 'room-1',
		propertyId: 'prop-1',
		blockId: null,
		roomNumber: '101',
		roomCode: null,
		roomType: 'standard',
		floor: 1,
		status: 'debt',
		monthlyRent: 3_000_000,
		area: 20,
		debtAmount: 0,
		paymentAccountId: 'acc-1',
		tenantId: 'tenant-1',
		currentManagedTenantId: null,
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
		services: [],
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

	expectNoForbiddenKeys(dto);
	assert.equal('passwordHash' in dto.tenant!.user, false);
});
