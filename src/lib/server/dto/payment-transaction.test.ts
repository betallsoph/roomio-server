import assert from 'node:assert/strict';
import test from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { toPaymentTransactionDto } from './payment-transaction.js';

const PAYMENT_TRANSACTION_BASE_KEYS = [
	'id',
	'landlordId',
	'invoiceId',
	'paymentAccountId',
	'provider',
	'providerTransactionId',
	'invoiceCode',
	'amount',
	'transferType',
	'content',
	'status',
	'receivedAt'
] as const;

test('toPaymentTransactionDto never exposes rawPayload or nested secrets', () => {
	const dto = toPaymentTransactionDto({
		id: 'txn-1',
		landlordId: 'landlord-1',
		invoiceId: 'INV-202607-1234',
		paymentAccountId: 'acc-1',
		provider: 'payos',
		providerTransactionId: 'provider-txn-1',
		invoiceCode: 'INV-202607-1234',
		amount: 3_500_000,
		transferType: 'bank',
		content: 'Payment',
		status: 'applied',
		receivedAt: new Date('2026-07-28T10:00:00.000Z'),
		rawPayload: '{"secret":true}',
		invoice: {
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
			status: 'paid',
			paidAmount: 3_500_000,
			paymentProofImage: null,
			paymentMethod: 'payos_webhook',
			paymentProvider: 'payos',
			paymentAccountId: 'acc-1',
			payosOrderCode: '123456',
			payosPaymentLinkId: 'link-1',
			payosCheckoutUrl: 'https://payos.vn/checkout',
			payosQrCode: 'qr-data',
			payosStatus: 'PAID',
			createdAt: '2026-07-01',
			notes: null,
			managedTenantId: null,
			tenancyId: null
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
		[...PAYMENT_TRANSACTION_BASE_KEYS, 'invoice', 'paymentAccount'].sort()
	);
	expectNoForbiddenKeys(dto);
	assert.equal('rawPayload' in dto, false);
});
