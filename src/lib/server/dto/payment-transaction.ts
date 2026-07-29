import { toInvoiceDto, type InvoiceDto } from './invoice.js';
import {
	toPaymentAccountDto,
	type PaymentAccountDto,
	type PaymentAccountRowForDto
} from './payment-account.js';

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

export type PaymentTransactionDto = {
	id: string;
	landlordId: string | null;
	invoiceId: string | null;
	paymentAccountId: string | null;
	provider: string;
	providerTransactionId: string | null;
	invoiceCode: string | null;
	amount: number;
	transferType: string;
	content: string | null;
	status: string;
	receivedAt: string;
	invoice?: InvoiceDto | null;
	paymentAccount?: PaymentAccountDto | null;
};

type PaymentTransactionRowForDto = {
	id: string;
	landlordId: string | null;
	invoiceId: string | null;
	paymentAccountId: string | null;
	provider: string;
	providerTransactionId: string | null;
	invoiceCode: string | null;
	amount: number;
	transferType: string;
	content: string | null;
	status: string;
	receivedAt: Date | string;
	rawPayload?: string;
	invoice?: Parameters<typeof toInvoiceDto>[0] | null;
	paymentAccount?: PaymentAccountRowForDto | null;
};

export function toPaymentTransactionDto(row: PaymentTransactionRowForDto): PaymentTransactionDto {
	const dto: PaymentTransactionDto = {
		id: row.id,
		landlordId: row.landlordId,
		invoiceId: row.invoiceId,
		paymentAccountId: row.paymentAccountId,
		provider: row.provider,
		providerTransactionId: row.providerTransactionId,
		invoiceCode: row.invoiceCode,
		amount: row.amount,
		transferType: row.transferType,
		content: row.content,
		status: row.status,
		receivedAt: toIso(row.receivedAt)
	};

	if (row.invoice !== undefined) {
		dto.invoice = row.invoice ? toInvoiceDto(row.invoice) : null;
	}
	if (row.paymentAccount !== undefined) {
		dto.paymentAccount = row.paymentAccount ? toPaymentAccountDto(row.paymentAccount) : null;
	}

	return dto;
}
