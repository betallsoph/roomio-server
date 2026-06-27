import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, landlordProfiles } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { forbidden, landlordOwnsInvoice, tenantOwnsInvoice } from '$lib/server/authz';
import { createPayOSPaymentLink, makePayOSOrderCode, resolvePayOSConfig } from '$lib/server/payos';

function paymentDescription(invoiceId: string) {
	const compact = invoiceId
		.replace(/[^A-Z0-9]/gi, '')
		.slice(-9)
		.toUpperCase();
	return `RIO${compact}`.slice(0, 25);
}

// VietQR quick-link (ảnh QR miễn phí của vietqr.io) — tiền chuyển THẲNG vào TK ngân hàng chủ trọ.
// Dùng khi chủ trọ CHƯA kết nối PayOS riêng: hiển thị QR, đối soát thủ công bằng nút "Đã nhận".
function buildVietQRImageUrl(opts: {
	bankCode: string;
	accountNumber: string;
	accountName: string;
	amount: number;
	description: string;
}) {
	const base = `https://img.vietqr.io/image/${encodeURIComponent(opts.bankCode)}-${encodeURIComponent(opts.accountNumber)}-compact2.png`;
	const params = new URLSearchParams({
		amount: String(Math.round(opts.amount)),
		addInfo: opts.description,
		accountName: opts.accountName
	});
	return `${base}?${params.toString()}`;
}

const STALE_PAYOS_STATUSES = ['CANCELLED', 'EXPIRED'];

export const POST: RequestHandler = async ({ params, locals }) => {
	try {
		const { id } = params;
		if (!id) {
			return json({ error: 'Missing invoice ID' }, { status: 400 });
		}

		const invoice = await db.query.invoices.findFirst({
			where: eq(invoices.id, id),
			with: {
				items: true,
				room: { with: { property: { columns: { landlordId: true } } } }
			}
		});
		if (!invoice) {
			return json({ error: 'Invoice not found' }, { status: 404 });
		}
		if (invoice.status === 'paid') {
			return json({ error: 'Hóa đơn đã thanh toán' }, { status: 400 });
		}

		// Quyền: khách thuê sở hữu HĐ, hoặc chủ trọ sở hữu HĐ
		if (
			locals.session?.role === 'TENANT' &&
			!(await tenantOwnsInvoice(locals.session.tenantProfileId!, id))
		) {
			return forbidden();
		}
		if (
			locals.session?.role === 'LANDLORD' &&
			!(await landlordOwnsInvoice(locals.session.landlordProfileId!, id))
		) {
			return forbidden();
		}
		if (locals.session?.role !== 'TENANT' && locals.session?.role !== 'LANDLORD') {
			return forbidden();
		}

		const landlordId = invoice.room.property.landlordId;
		const amountDue = Math.max(invoice.totalAmount - invoice.paidAmount, 0);
		const description = paymentDescription(invoice.id);

		// Link PayOS cũ còn hiệu lực → trả lại luôn (idempotent)
		const hasLiveLink =
			invoice.payosCheckoutUrl &&
			invoice.payosPaymentLinkId &&
			!STALE_PAYOS_STATUSES.includes(invoice.payosStatus ?? '');
		if (hasLiveLink) {
			return json({
				provider: 'payos',
				orderCode: Number(invoice.payosOrderCode),
				paymentLinkId: invoice.payosPaymentLinkId,
				checkoutUrl: invoice.payosCheckoutUrl,
				qrCode: invoice.payosQrCode,
				status: invoice.payosStatus
			});
		}

		const config = await resolvePayOSConfig({ scope: 'rent', landlordId });

		// Chủ trọ CHƯA kết nối PayOS riêng → VietQR + xác nhận thủ công
		if (!config) {
			const profile = await db.query.landlordProfiles.findFirst({
				where: eq(landlordProfiles.id, landlordId),
				columns: { bankName: true, bankCode: true, accountNumber: true, accountName: true }
			});
			if (!profile?.accountNumber || !profile.bankCode) {
				return json({ error: 'Chủ trọ chưa cấu hình tài khoản nhận tiền' }, { status: 400 });
			}
			return json({
				provider: 'vietqr',
				bankName: profile.bankName,
				bankCode: profile.bankCode,
				accountNumber: profile.accountNumber,
				accountName: profile.accountName,
				amount: amountDue,
				description,
				qrImageUrl: buildVietQRImageUrl({
					bankCode: profile.bankCode,
					accountNumber: profile.accountNumber,
					accountName: profile.accountName,
					amount: amountDue,
					description
				})
			});
		}

		// Fix B: KHÔNG tái dùng orderCode cũ nếu link trước đã hủy/hết hạn (PayOS cấm tái dùng)
		const stale = STALE_PAYOS_STATUSES.includes(invoice.payosStatus ?? '');
		const orderCode =
			invoice.payosOrderCode && !stale
				? Number(invoice.payosOrderCode)
				: makePayOSOrderCode(stale ? `${invoice.id}:${Date.now()}` : invoice.id);

		const paymentLink = await createPayOSPaymentLink(config, {
			invoiceId: invoice.id,
			orderCode,
			amount: amountDue,
			description,
			buyerName: invoice.tenantName,
			buyerPhone: invoice.tenantPhone,
			items:
				invoice.items.length > 0
					? invoice.items.map((item) => ({ name: item.name, quantity: 1, price: item.amount }))
					: [{ name: `Hoa don ${invoice.id}`, quantity: 1, price: invoice.totalAmount }]
		});

		await db
			.update(invoices)
			.set({
				paymentProvider: 'payos',
				payosOrderCode: String(paymentLink.orderCode),
				payosPaymentLinkId: paymentLink.paymentLinkId,
				payosCheckoutUrl: paymentLink.checkoutUrl,
				payosQrCode: paymentLink.qrCode,
				payosStatus: paymentLink.status
			})
			.where(eq(invoices.id, invoice.id));

		return json({
			provider: 'payos',
			orderCode: paymentLink.orderCode,
			paymentLinkId: paymentLink.paymentLinkId,
			checkoutUrl: paymentLink.checkoutUrl,
			qrCode: paymentLink.qrCode,
			status: paymentLink.status
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
