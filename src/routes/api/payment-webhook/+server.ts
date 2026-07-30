import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, paymentTransactions, rooms } from '$lib/server/db/schema';
import { eq, or, sql } from 'drizzle-orm';
import { resolvePayOSConfig, verifyPayOSWebhook } from '$lib/server/payos';
import { childRequestLogger } from '$lib/server/logger';
import {
	createMachineActor,
	extractPayOSOrderIdentifiers,
	logMachineVerificationFailure,
	parsePayOSWebhookBody
} from '$lib/server/authorization/machine-verification';

// Webhook tiền thuê (khách thuê → chủ trọ). Mỗi chủ trọ dùng PayOS RIÊNG: đọc orderCode/paymentLinkId
// chỉ để map READ-ONLY tới hóa đơn → suy ra checksumKey chủ trọ, VERIFY chữ ký, rồi mới ghi DB.
// Không ghi operational table trước verify; unmatched/unverified chỉ log bảo mật.

export const POST: RequestHandler = async ({ request, locals }) => {
	const log = childRequestLogger(locals.requestId, { handler: 'payos-webhook' });

	try {
		const body = await request.json();
		const parsed = parsePayOSWebhookBody(body);
		if (!parsed) {
			logMachineVerificationFailure(log, locals.requestId, 'PAYMENT_WEBHOOK', 'invalid_payload');
			return json({ error: 'Payload PayOS không hợp lệ' }, { status: 400 });
		}

		const { data, signature, code, desc, success } = parsed;
		const { orderCode, paymentLinkId, amount, providerTransactionId } =
			extractPayOSOrderIdentifiers(data);

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

		if (!invoice) {
			logMachineVerificationFailure(log, locals.requestId, 'PAYMENT_WEBHOOK', 'unmatched_invoice', {
				orderCode,
				paymentLinkId
			});
			return json({ success: true, message: 'Không tìm thấy hóa đơn khớp PayOS' });
		}

		const landlordId = invoice.room.property.landlordId;
		const config = await resolvePayOSConfig({
			scope: 'rent',
			landlordId,
			paymentAccountId: invoice.paymentAccountId
		});
		if (!config) {
			logMachineVerificationFailure(
				log,
				locals.requestId,
				'PAYMENT_WEBHOOK',
				'missing_payos_config',
				{
					landlordId,
					invoiceId: invoice.id
				}
			);
			return json({ error: 'Chủ trọ chưa kết nối PayOS để nhận webhook' }, { status: 400 });
		}

		if (!verifyPayOSWebhook(data, signature, config.checksumKey)) {
			logMachineVerificationFailure(log, locals.requestId, 'PAYMENT_WEBHOOK', 'invalid_signature', {
				landlordId,
				invoiceId: invoice.id,
				orderCode
			});
			return json({ error: 'Sai chữ ký PayOS' }, { status: 401 });
		}

		const actor = createMachineActor('PAYMENT_WEBHOOK', locals.requestId, {
			verifiedAccountId: invoice.paymentAccountId ?? undefined
		});

		const existingTransaction = await db.query.paymentTransactions.findFirst({
			where: eq(paymentTransactions.providerTransactionId, providerTransactionId),
			columns: { id: true }
		});
		if (existingTransaction) {
			return json({ success: true, message: 'Giao dịch PayOS đã được xử lý trước đó' });
		}

		const rawPayload = JSON.stringify(body);
		const paymentContent =
			data.description !== undefined && data.description !== null ? String(data.description) : null;
		const ignoredContent =
			desc ??
			(data.desc !== undefined ? String(data.desc) : null) ??
			'PayOS webhook không thành công';

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
				content: ignoredContent,
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
				content: paymentContent,
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
				content: paymentContent,
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
				outcome: fullyPaid ? 'paid' : 'partial',
				machineChannel: actor.channel,
				verifiedAccountId: actor.verifiedAccountId
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
