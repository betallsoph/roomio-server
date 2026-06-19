import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { forbidden, landlordOwnsInvoice, tenantOwnsInvoice } from '$lib/server/authz';
import { createPayOSPaymentLink, makePayOSOrderCode } from '$lib/server/payos';

function paymentDescription(invoiceId: string) {
	const compact = invoiceId.replace(/[^A-Z0-9]/gi, '').slice(-9).toUpperCase();
	return `RIO${compact}`.slice(0, 25);
}

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
				room: {
					with: {
						property: {
							columns: { landlordId: true }
						}
					}
				}
			}
		});
		if (!invoice) {
			return json({ error: 'Invoice not found' }, { status: 404 });
		}
		if (invoice.status === 'paid') {
			return json({ error: 'Hóa đơn đã thanh toán' }, { status: 400 });
		}

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

		if (invoice.payosCheckoutUrl && invoice.payosPaymentLinkId && invoice.payosStatus !== 'CANCELLED') {
			return json({
				provider: 'payos',
				orderCode: Number(invoice.payosOrderCode),
				paymentLinkId: invoice.payosPaymentLinkId,
				checkoutUrl: invoice.payosCheckoutUrl,
				qrCode: invoice.payosQrCode,
				status: invoice.payosStatus
			});
		}

		const orderCode = makePayOSOrderCode(invoice.id, invoice.payosOrderCode);
		const paymentLink = await createPayOSPaymentLink({
			invoiceId: invoice.id,
			orderCode,
			amount: Math.max(invoice.totalAmount - invoice.paidAmount, 0),
			description: paymentDescription(invoice.id),
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
