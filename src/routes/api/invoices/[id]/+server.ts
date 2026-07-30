import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, paymentTransactions, rooms } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireLandlordActor, requireTenantActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import { findInvoiceForLandlord } from '$lib/server/authorization/scoped-queries';
import { toInvoiceDto } from '$lib/server/dto/invoice';
import {
	getInvoiceForLandlord,
	getInvoiceForTenant,
	mapFinanceScopeError
} from '$lib/server/operations/finance-scope';
import { isOperationsError } from '$lib/server/operations/errors';

function mapHandlerError(error: unknown) {
	const mapped = mapFinanceScopeError(error);
	if (mapped) {
		return json({ error: mapped.message }, { status: mapped.status });
	}
	if (isAuthorizationError(error)) {
		return authorizationErrorToResponse(error);
	}
	if (isOperationsError(error)) {
		return json({ error: error.message }, { status: error.status });
	}
	return json({ error: errorMessage(error) }, { status: 500 });
}

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const { id } = params;
		if (!id) {
			return json({ error: 'Missing invoice ID' }, { status: 400 });
		}

		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			const invoice = await getInvoiceForLandlord(db, landlord.value, id);
			if (!invoice) {
				return json({ error: 'Invoice not found' }, { status: 404 });
			}
			return json(toInvoiceDto(invoice));
		}

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			const invoice = await getInvoiceForTenant(db, tenant.value, id);
			if (!invoice) {
				return json({ error: 'Invoice not found' }, { status: 404 });
			}
			return json(toInvoiceDto(invoice));
		}

		return authorizationErrorToResponse(wrongRoleError('Không có quyền truy cập dữ liệu này'));
	} catch (error) {
		return mapHandlerError(error);
	}
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { id } = params;
		const body = await request.json();
		const { action, paymentProofImage, paidAmount } = body;

		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok && action !== 'uploadProof') {
			return json({ error: 'Khách thuê chỉ được gửi ảnh xác nhận chuyển khoản' }, { status: 403 });
		}

		if (!id) {
			return json({ error: 'Missing invoice ID' }, { status: 400 });
		}

		const landlord = requireLandlordActor(guard.actor);
		const tenantActor = requireTenantActor(guard.actor);
		if (!landlord.ok && !tenantActor.ok) {
			return authorizationErrorToResponse(wrongRoleError('Không có quyền truy cập dữ liệu này'));
		}

		if (action === 'uploadProof') {
			if (tenantActor.ok) {
				await getInvoiceForTenant(db, tenantActor.value, id);
			} else if (landlord.ok) {
				await findInvoiceForLandlord(db, landlord.value, id);
			}
		} else if (!landlord.ok) {
			return json(
				{ error: 'Chỉ chủ trọ sở hữu hóa đơn này được cập nhật thanh toán' },
				{ status: 403 }
			);
		} else {
			await findInvoiceForLandlord(db, landlord.value, id);
		}

		const invoice = await db.query.invoices.findFirst({
			where: eq(invoices.id, id),
			with: { room: true }
		});
		if (!invoice) {
			return json({ error: 'Invoice not found' }, { status: 404 });
		}

		if (action === 'confirmPaid') {
			if (!landlord.ok) {
				return json({ error: 'Chỉ chủ trọ sở hữu hóa đơn này được cập nhật thanh toán' }, { status: 403 });
			}
			const landlordActor = landlord.value;

			const alreadyPaid = invoice.status === 'paid';
			if (alreadyPaid) {
				return json({ error: 'Invoice is already paid' }, { status: 400 });
			}

			const updated = await db.transaction(async (tx) => {
				const outstandingAmount = Math.max(invoice.totalAmount - invoice.paidAmount, 0);

				const inv = (
					await tx
						.update(invoices)
						.set({
							status: 'paid',
							paidAmount: invoice.totalAmount,
							paidDate: new Date().toISOString().split('T')[0]
						})
						.where(eq(invoices.id, id))
						.returning()
				)[0];

				await tx.insert(paymentTransactions).values({
					landlordId: landlordActor.landlordId,
					invoiceId: id,
					paymentAccountId: invoice.paymentAccountId,
					provider: 'manual',
					providerTransactionId: `manual:${id}:${Date.now()}`,
					invoiceCode: id,
					amount: outstandingAmount,
					transferType: 'manual',
					content: 'Chủ trọ xác nhận đã nhận đủ tiền',
					status: 'applied',
					rawPayload: JSON.stringify({ action: 'confirmPaid', invoiceId: id })
				});

				await tx
					.update(rooms)
					.set({
						status: 'paid',
						debtAmount: sql`coalesce(${rooms.debtAmount}, 0) - ${outstandingAmount}`
					})
					.where(eq(rooms.id, invoice.roomId));

				return inv;
			});

			return json(toInvoiceDto(updated));
		}

		if (action === 'uploadProof') {
			if (!paymentProofImage) {
				return json({ error: 'Missing payment proof image url' }, { status: 400 });
			}

			const updated = await db
				.update(invoices)
				.set({
					paymentProofImage,
					status: 'pending'
				})
				.where(eq(invoices.id, id))
				.returning();

			return json(toInvoiceDto(updated[0]));
		}

		const updateData: Record<string, unknown> = {};
		if (paidAmount !== undefined) {
			updateData.paidAmount = Number(paidAmount);
			if (Number(paidAmount) >= invoice.totalAmount) {
				updateData.status = 'paid';
				updateData.paidDate = new Date().toISOString().split('T')[0];
			}
		}

		if (Object.keys(updateData).length === 0) {
			return json(toInvoiceDto(invoice));
		}

		const updated = await db
			.update(invoices)
			.set(updateData)
			.where(eq(invoices.id, id))
			.returning();

		return json(toInvoiceDto(updated[0]));
	} catch (error) {
		return mapHandlerError(error);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const { id } = params;
		if (!id) {
			return json({ error: 'Missing invoice ID' }, { status: 400 });
		}

		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;
		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(landlord.error);
		}

		await findInvoiceForLandlord(db, landlord.value, id);

		const invoice = await db.query.invoices.findFirst({
			where: eq(invoices.id, id)
		});
		if (!invoice) {
			return json({ error: 'Invoice not found' }, { status: 404 });
		}

		await db.transaction(async (tx) => {
			await tx.delete(invoices).where(eq(invoices.id, id));

			if (invoice.status !== 'paid') {
				const outstanding = Math.max(invoice.totalAmount - invoice.paidAmount, 0);
				await tx
					.update(rooms)
					.set({
						debtAmount: sql`coalesce(${rooms.debtAmount}, 0) - ${outstanding}`
					})
					.where(eq(rooms.id, invoice.roomId));
			}
		});

		return json({ success: true });
	} catch (error) {
		return mapHandlerError(error);
	}
};
