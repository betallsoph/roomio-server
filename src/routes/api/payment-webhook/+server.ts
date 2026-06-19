import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, paymentTransactions, rooms } from '$lib/server/db/schema';
import { eq, or, sql } from 'drizzle-orm';
import { getPayOSConfig, verifyPayOSWebhook } from '$lib/server/payos';

// Webhook payOS gửi payload dạng { code, desc, success, data, signature }.
// Chữ ký được verify bằng PAYOS_CHECKSUM_KEY trên object `data` đã sort key theo docs payOS.

export const POST: RequestHandler = async ({ request }) => {
	try {
		const config = getPayOSConfig();
		if (!config) {
			return json({ error: 'Chưa cấu hình PAYOS_CLIENT_ID, PAYOS_API_KEY và PAYOS_CHECKSUM_KEY' }, { status: 500 });
		}

		const body = await request.json();
		const { code, desc, success, data, signature } = body;
		if (!data || typeof data !== 'object' || !signature) {
			return json({ error: 'Payload PayOS không hợp lệ' }, { status: 400 });
		}
		if (!verifyPayOSWebhook(data, String(signature), config.checksumKey)) {
			return json({ error: 'Sai chữ ký PayOS' }, { status: 401 });
		}

		const orderCode = data.orderCode !== undefined ? String(data.orderCode) : null;
		const paymentLinkId = data.paymentLinkId ? String(data.paymentLinkId) : null;
		const amount = Number(data.amount) || 0;
		const providerTransactionId = String(
			data.reference ?? `${orderCode ?? 'unknown'}:${paymentLinkId ?? 'unknown'}:${data.transactionDateTime ?? ''}:${amount}`
		);
		const rawPayload = JSON.stringify(body);

		const existingTransaction = await db.query.paymentTransactions.findFirst({
			where: eq(paymentTransactions.providerTransactionId, providerTransactionId),
			columns: { id: true }
		});
		if (existingTransaction) {
			return json({ success: true, message: 'Giao dịch PayOS đã được xử lý trước đó' });
		}

		const matchCondition =
			orderCode && paymentLinkId
				? or(eq(invoices.payosOrderCode, orderCode), eq(invoices.payosPaymentLinkId, paymentLinkId))
				: orderCode
					? eq(invoices.payosOrderCode, orderCode)
					: paymentLinkId
						? eq(invoices.payosPaymentLinkId, paymentLinkId)
						: undefined;

		const invoice = matchCondition
			? await db.query.invoices.findFirst({
					where: matchCondition,
					with: {
						room: {
							with: {
								property: {
									columns: { landlordId: true }
								}
							}
						}
					}
				})
			: null;

		if (!success || code !== '00' || data.code !== '00') {
			await db.insert(paymentTransactions).values({
				landlordId: invoice?.room.property.landlordId ?? null,
				invoiceId: invoice?.id ?? null,
				provider: 'payos',
				providerTransactionId,
				invoiceCode: orderCode,
				amount,
				transferType: 'webhook',
				content: desc ?? data.desc ?? 'PayOS webhook không thành công',
				status: 'ignored',
				rawPayload
			});
			return json({ success: true, message: 'Bỏ qua webhook PayOS không thành công' });
		}

		if (!invoice) {
			await db.insert(paymentTransactions).values({
				provider: 'payos',
				providerTransactionId,
				invoiceCode: orderCode,
				amount,
				transferType: 'webhook',
				content: data.description ?? null,
				status: 'unmatched',
				rawPayload
			});
			return json({ success: true, message: 'Không tìm thấy hóa đơn khớp PayOS' });
		}

		if (invoice.status === 'paid') {
			await db.insert(paymentTransactions).values({
				landlordId: invoice.room.property.landlordId,
				invoiceId: invoice.id,
				provider: 'payos',
				providerTransactionId,
				invoiceCode: orderCode,
				amount,
				transferType: 'webhook',
				content: data.description ?? null,
				status: 'duplicate',
				rawPayload
			});
			return json({ success: true, message: 'Hóa đơn đã được thanh toán trước đó' });
		}

		const newPaidAmount = invoice.paidAmount + amount;
		const fullyPaid = newPaidAmount >= invoice.totalAmount;
		const today = new Date().toISOString().split('T')[0];

		await db.transaction(async (tx) => {
			await tx.insert(paymentTransactions).values({
				landlordId: invoice.room.property.landlordId,
				invoiceId: invoice.id,
				provider: 'payos',
				providerTransactionId,
				invoiceCode: orderCode,
				amount,
				transferType: 'webhook',
				content: data.description ?? null,
				status: 'applied',
				rawPayload
			});

			await tx
				.update(invoices)
				.set({
					paidAmount: newPaidAmount,
					status: fullyPaid ? 'paid' : 'partial',
					paidDate: fullyPaid ? today : null,
					paymentMethod: 'payos_webhook',
					paymentProvider: 'payos',
					payosOrderCode: orderCode,
					payosPaymentLinkId: paymentLinkId,
					payosStatus: fullyPaid ? 'PAID' : 'PARTIAL'
				})
				.where(eq(invoices.id, invoice.id));

			await tx
				.update(rooms)
				.set({
					debtAmount: sql`greatest(coalesce(${rooms.debtAmount}, 0) - ${amount}, 0)`,
					...(fullyPaid ? { status: 'paid' } : {})
				})
				.where(eq(rooms.id, invoice.roomId));
		});

		return json({ success: true, invoiceId: invoice.id, status: fullyPaid ? 'paid' : 'partial' });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
