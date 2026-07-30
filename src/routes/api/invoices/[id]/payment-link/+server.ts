import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireLandlordActor, requireTenantActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import {
	findPaymentAccountForTenantHistory,
	ScopedResourceNotFoundError
} from '$lib/server/authorization/scoped-queries';
import { createPayOSPaymentLink, makePayOSOrderCode, resolvePayOSConfig } from '$lib/server/payos';
import {
	getInvoiceForLandlord,
	getInvoiceForTenant,
	getPaymentAccountForInvoiceLandlord,
	mapFinanceScopeError
} from '$lib/server/operations/finance-scope';
import { isOperationsError } from '$lib/server/operations/errors';

function paymentDescription(invoiceId: string) {
	const compact = invoiceId
		.replace(/[^A-Z0-9]/gi, '')
		.slice(-9)
		.toUpperCase();
	return `RIO${compact}`.slice(0, 25);
}

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

function mapHandlerError(error: unknown) {
	const mapped = mapFinanceScopeError(error);
	if (mapped) {
		return json({ error: mapped.message }, { status: mapped.status });
	}
	if (error instanceof ScopedResourceNotFoundError) {
		return json({ error: error.message }, { status: 404 });
	}
	if (isAuthorizationError(error)) {
		return authorizationErrorToResponse(error);
	}
	if (isOperationsError(error)) {
		return json({ error: error.message }, { status: error.status });
	}
	return json({ error: errorMessage(error) }, { status: 500 });
}

export const POST: RequestHandler = async ({ params, locals }) => {
	try {
		const { id } = params;
		if (!id) {
			return json({ error: 'Missing invoice ID' }, { status: 400 });
		}

		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		const tenant = requireTenantActor(guard.actor);
		if (!landlord.ok && !tenant.ok) {
			return authorizationErrorToResponse(wrongRoleError('Không có quyền truy cập dữ liệu này'));
		}

		let invoice;
		let landlordId: string;
		let paymentAccount;

		if (landlord.ok) {
			invoice = await getInvoiceForLandlord(db, landlord.value, id);
			if (!invoice) {
				return json({ error: 'Invoice not found' }, { status: 404 });
			}
			landlordId = landlord.value.landlordId;
			paymentAccount = await getPaymentAccountForInvoiceLandlord(db, landlord.value, id);
		} else if (tenant.ok) {
			const tenantActor = tenant.value;
			invoice = await getInvoiceForTenant(db, tenantActor, id);
			if (!invoice?.managedTenantId || !invoice.tenancyId) {
				return json({ error: 'Invoice not found' }, { status: 404 });
			}
			const propertyLandlord = invoice.room?.property?.landlord?.id;
			if (!propertyLandlord) {
				return json({ error: 'Invoice not found' }, { status: 404 });
			}
			landlordId = propertyLandlord;
			paymentAccount = await findPaymentAccountForTenantHistory(
				db,
				tenantActor,
				{
					managedTenantId: invoice.managedTenantId,
					tenancyId: invoice.tenancyId
				},
				id
			);
		} else {
			return authorizationErrorToResponse(wrongRoleError('Không có quyền truy cập dữ liệu này'));
		}

		if (invoice.status === 'paid') {
			return json({ error: 'Hóa đơn đã thanh toán' }, { status: 400 });
		}

		const amountDue = Math.max(invoice.totalAmount - invoice.paidAmount, 0);
		const description = paymentDescription(invoice.id);

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

		const config = await resolvePayOSConfig({
			scope: 'rent',
			landlordId,
			paymentAccountId: paymentAccount.id
		});

		if (!config) {
			if (!paymentAccount.accountNumber || !paymentAccount.bankCode) {
				return json({ error: 'Chủ trọ chưa cấu hình tài khoản nhận tiền' }, { status: 400 });
			}
			return json({
				provider: 'vietqr',
				paymentAccountId: paymentAccount.id,
				paymentAccountName: paymentAccount.name,
				bankName: paymentAccount.bankName,
				bankCode: paymentAccount.bankCode,
				accountNumber: paymentAccount.accountNumber,
				accountName: paymentAccount.accountName,
				amount: amountDue,
				description,
				qrImageUrl: buildVietQRImageUrl({
					bankCode: paymentAccount.bankCode,
					accountNumber: paymentAccount.accountNumber,
					accountName: paymentAccount.accountName,
					amount: amountDue,
					description
				})
			});
		}

		const stale = STALE_PAYOS_STATUSES.includes(invoice.payosStatus ?? '');
		const orderCode =
			invoice.payosOrderCode && !stale
				? Number(invoice.payosOrderCode)
				: makePayOSOrderCode(stale ? `${invoice.id}:${Date.now()}` : invoice.id);

		const invoiceItems = invoice.items ?? [];
		const paymentLink = await createPayOSPaymentLink(config, {
			invoiceId: invoice.id,
			orderCode,
			amount: amountDue,
			description,
			buyerName: invoice.tenantName,
			buyerPhone: invoice.tenantPhone,
			items:
				invoiceItems.length > 0
					? invoiceItems.map((item) => ({ name: item.name, quantity: 1, price: item.amount }))
					: [{ name: `Hoa don ${invoice.id}`, quantity: 1, price: invoice.totalAmount }]
		});

		await db
			.update(invoices)
			.set({
				paymentProvider: 'payos',
				paymentAccountId: paymentAccount.id,
				payosOrderCode: String(paymentLink.orderCode),
				payosPaymentLinkId: paymentLink.paymentLinkId,
				payosCheckoutUrl: paymentLink.checkoutUrl,
				payosQrCode: paymentLink.qrCode,
				payosStatus: paymentLink.status
			})
			.where(eq(invoices.id, invoice.id));

		return json({
			provider: 'payos',
			paymentAccountId: paymentAccount.id,
			paymentAccountName: paymentAccount.name,
			orderCode: paymentLink.orderCode,
			paymentLinkId: paymentLink.paymentLinkId,
			checkoutUrl: paymentLink.checkoutUrl,
			qrCode: paymentLink.qrCode,
			status: paymentLink.status
		});
	} catch (error) {
		return mapHandlerError(error);
	}
};
