import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, paymentTransactions, rooms } from '$lib/server/db/schema';
import { eq, or, sql } from 'drizzle-orm';
import { resolvePayOSConfig, verifyPayOSWebhook } from '$lib/server/payos';
import { childRequestLogger } from '$lib/server/logger';

// Webhook tiền thuê (khách thuê → chủ trọ). Mỗi chủ trọ dùng PayOS RIÊNG nên không thể verify
// trước khi biết hóa đơn thuộc chủ trọ nào: ta MATCH hóa đơn theo orderCode/paymentLinkId TRƯỚC
// (đọc dữ liệu chưa tin), suy ra chủ trọ, rồi VERIFY chữ ký bằng checksumKey của chính chủ trọ đó.
// Chỉ áp tiền SAU khi chữ ký hợp lệ. orderCode được sinh tất định toàn cục (từ invoiceId) nên
// match 1 endpoint không nhầm giữa các chủ trọ.

export const POST: RequestHandler = async ({ request, locals }) => {
	const log = childRequestLogger(locals.requestId, { handler: 'payos-webhook' });

	try {
		const body = await request.json();
		const { code, desc, success, data, signature } = body;
		if (!data || typeof data !== 'object' || !signature) {
			return json({ error: 'Payload PayOS không hợp lệ' }, { status: 400 });
		}

		const orderCode = data.orderCode !== undefined ? String(data.orderCode) : null;
		const paymentLinkId = data.paymentLinkId ? String(data.paymentLinkId) : null;
		const amount = Number(data.amount) || 0;
		const providerTransactionId = String(
			data.reference ??
				`${orderCode ?? 'unknown'}:${paymentLinkId ?? 'unknown'}:${data.transactionDateTime ?? ''}:${amount}`
		);
		const rawPayload = JSON.stringify(body);

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
					with: { room: { with: { property: { columns: { landlordId: true } } } } }
				})
			: null;

		// Không khớp hóa đơn → chưa biết key chủ trọ nào để verify; log (KHÔNG áp tiền) rồi ack 200.
		if (!invoice) {
			log.info({ orderCode, outcome: 'unmatched' }, 'payos webhook received');
			await db.insert(paymentTransactions).values({
				provider: 'payos',
				providerTransactionId,
				invoiceCode: orderCode,
				amount,
				transferType: 'webhook',
				content: data.description ?? 'PayOS webhook không khớp hóa đơn',
				status: 'unmatched',
				rawPayload
			});
			return json({ success: true, message: 'Không tìm thấy hóa đơn khớp PayOS' });
		}

		const landlordId = invoice.room.property.landlordId;

		// Verify bằng checksumKey RIÊNG của chủ trọ sở hữu hóa đơn này
		const config = await resolvePayOSConfig({
			scope: 'rent',
			landlordId,
			paymentAccountId: invoice.paymentAccountId
		});
		if (!config) {
			return json({ error: 'Chủ trọ chưa kết nối PayOS để nhận webhook' }, { status: 400 });
		}
		if (!verifyPayOSWebhook(data, String(signature), config.checksumKey)) {
			return json({ error: 'Sai chữ ký PayOS' }, { status: 401 });
		}

		// Chống xử lý trùng (chỉ sau khi đã verify chữ ký)
		const existingTransaction = await db.query.paymentTransactions.findFirst({
			where: eq(paymentTransactions.providerTransactionId, providerTransactionId),
			columns: { id: true }
		});
		if (existingTransaction) {
			return json({ success: true, message: 'Giao dịch PayOS đã được xử lý trước đó' });
		}

		// Webhook báo thất bại → log ignored rồi ack
		if (!success || code !== '00' || data.code !== '00') {
			await db.insert(paymentTransactions).values({
				landlordId,
				invoiceId: invoice.id,
				paymentAccountId: invoice.paymentAccountId,
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

		if (invoice.status === 'paid') {
			await db.insert(paymentTransactions).values({
				landlordId,
				invoiceId: invoice.id,
				paymentAccountId: invoice.paymentAccountId,
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
				landlordId,
				invoiceId: invoice.id,
				paymentAccountId: invoice.paymentAccountId,
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

		log.info(
			{
				invoiceId: invoice.id,
				landlordId,
				orderCode,
				outcome: fullyPaid ? 'paid' : 'partial'
			},
			'payos webhook applied'
		);

		return json({ success: true, invoiceId: invoice.id, status: fullyPaid ? 'paid' : 'partial' });
	} catch (error) {
		log.error({ err: error }, 'payos webhook failed');
		return json(
			{ error: 'Đã xảy ra lỗi. Vui lòng thử lại sau.', requestId: locals.requestId },
			{ status: 500 }
		);
	}
};
