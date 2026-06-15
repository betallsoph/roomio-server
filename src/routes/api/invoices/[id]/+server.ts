import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, rooms } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params }) => {
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
							with: {
								landlord: true
							}
						}
					}
				}
			}
		});

		if (!invoice) {
			return json({ error: 'Invoice not found' }, { status: 404 });
		}

		return json(invoice);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { id } = params;
		const body = await request.json();
		const { action, paymentProofImage, paidAmount } = body;

		// Khách thuê chỉ được gửi ảnh bill, không được tự xác nhận thanh toán
		if (locals.session?.role === 'TENANT' && action !== 'uploadProof') {
			return json({ error: 'Khách thuê chỉ được gửi ảnh xác nhận chuyển khoản' }, { status: 403 });
		}

		if (!id) {
			return json({ error: 'Missing invoice ID' }, { status: 400 });
		}

		const invoice = await db.query.invoices.findFirst({
			where: eq(invoices.id, id),
			with: { room: true }
		});

		if (!invoice) {
			return json({ error: 'Invoice not found' }, { status: 404 });
		}

		if (action === 'confirmPaid') {
			const alreadyPaid = invoice.status === 'paid';
			if (alreadyPaid) {
				return json({ error: 'Invoice is already paid' }, { status: 400 });
			}

			const updated = await db.transaction(async (tx) => {
				// 1. Update invoice status
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

				// 2. Reduce the room's outstanding debt
				const outstandingAmount = Math.max(invoice.totalAmount - invoice.paidAmount, 0);
				await tx
					.update(rooms)
					.set({
						status: 'paid', // Mark as paid/clean
						debtAmount: sql`coalesce(${rooms.debtAmount}, 0) - ${outstandingAmount}`
					})
					.where(eq(rooms.id, invoice.roomId));

				return inv;
			});

			return json(updated);
		} else if (action === 'uploadProof') {
			if (!paymentProofImage) {
				return json({ error: 'Missing payment proof image url' }, { status: 400 });
			}

			const updated = await db
				.update(invoices)
				.set({
					paymentProofImage,
					status: 'pending' // Still pending review
				})
				.where(eq(invoices.id, id))
				.returning();

			return json(updated[0]);
		} else {
			// Standard update
			const updateData: Record<string, unknown> = {};
			if (paidAmount !== undefined) {
				updateData.paidAmount = Number(paidAmount);
				if (Number(paidAmount) >= invoice.totalAmount) {
					updateData.status = 'paid';
					updateData.paidDate = new Date().toISOString().split('T')[0];
				}
			}

			if (Object.keys(updateData).length === 0) {
				return json(invoice);
			}

			const updated = await db
				.update(invoices)
				.set(updateData)
				.where(eq(invoices.id, id))
				.returning();

			return json(updated[0]);
		}
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		const { id } = params;

		if (!id) {
			return json({ error: 'Missing invoice ID' }, { status: 400 });
		}

		const invoice = await db.query.invoices.findFirst({
			where: eq(invoices.id, id)
		});

		if (!invoice) {
			return json({ error: 'Invoice not found' }, { status: 404 });
		}

		await db.transaction(async (tx) => {
			// Delete invoice
			await tx.delete(invoices).where(eq(invoices.id, id));

			// If pending or unpaid, subtract from room debt
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
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
