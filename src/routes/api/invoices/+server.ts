import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, invoiceItems, rooms, properties } from '$lib/server/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { forbidden, landlordOwnsRoom, requireLandlord } from '$lib/server/authz';

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');
		const roomId = url.searchParams.get('roomId');
		const status = url.searchParams.get('status');

		const conditions = [];

		if (locals.session?.role === 'LANDLORD') {
			conditions.push(
				inArray(
					invoices.roomId,
					db
						.select({ id: rooms.id })
						.from(rooms)
						.innerJoin(properties, eq(rooms.propertyId, properties.id))
						.where(eq(properties.landlordId, locals.session.landlordProfileId!))
				)
			);
		} else if (locals.session?.role === 'TENANT') {
			if (!locals.session.tenantProfileId) return forbidden();
			conditions.push(
				inArray(
					invoices.roomId,
					db
						.select({ id: rooms.id })
						.from(rooms)
						.where(eq(rooms.tenantId, locals.session.tenantProfileId))
				)
			);
		} else if (landlordId) {
			conditions.push(
				inArray(
					invoices.roomId,
					db
						.select({ id: rooms.id })
						.from(rooms)
						.innerJoin(properties, eq(rooms.propertyId, properties.id))
						.where(eq(properties.landlordId, landlordId))
				)
			);
		} else if (tenantId) {
			conditions.push(
				inArray(
					invoices.roomId,
					db.select({ id: rooms.id }).from(rooms).where(eq(rooms.tenantId, tenantId))
				)
			);
		} else if (roomId) {
			conditions.push(eq(invoices.roomId, roomId));
		}

		if (status) {
			conditions.push(eq(invoices.status, status));
		}

		const result = await db.query.invoices.findMany({
			where: conditions.length > 0 ? and(...conditions) : undefined,
			with: {
				items: true,
				room: {
					with: {
						property: true,
						block: true
					}
				}
			},
			orderBy: [desc(invoices.month), desc(invoices.createdAt)]
		});

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const { roomId, month, rentAmount, dueDate, items, notes } = body;

		if (
			!roomId ||
			!month ||
			rentAmount === undefined ||
			!dueDate ||
			!items ||
			!Array.isArray(items)
		) {
			return json({ error: 'Missing required invoice parameters' }, { status: 400 });
		}
		if (!(await landlordOwnsRoom(auth.value, roomId))) {
			return forbidden();
		}

		const existingInvoice = await db.query.invoices.findFirst({
			where: and(eq(invoices.roomId, roomId), eq(invoices.month, month)),
			columns: { id: true }
		});
		if (existingInvoice) {
			return json({ error: 'Phòng này đã có hóa đơn cho tháng đã chọn' }, { status: 409 });
		}

		// Fetch room & active tenant
		const room = await db.query.rooms.findFirst({
			where: eq(rooms.id, roomId),
			with: {
				tenant: { with: { user: true } }
			}
		});

		if (!room) {
			return json({ error: 'Room not found' }, { status: 404 });
		}

		if (!room.tenant) {
			return json({ error: 'Room has no active tenant' }, { status: 400 });
		}

		const tenantName = room.tenant.user.name;
		const tenantPhone = room.tenant.user.phone;

		// Calculate total amount from items
		const invoiceItemList: { name: string; amount: number; details?: string }[] = items;
		const totalAmount = invoiceItemList.reduce((sum, item) => sum + Number(item.amount), 0);

		// Generate Invoice ID
		const randomHex = Math.floor(1000 + Math.random() * 9000).toString();
		const invoiceId = `INV-${month.replace('-', '')}-${randomHex}`;

		const invoice = await db.transaction(async (tx) => {
			// 1. Create Invoice
			const inv = (
				await tx
					.insert(invoices)
					.values({
						id: invoiceId,
						roomId,
						roomNumber: room.roomNumber,
						tenantName,
						tenantPhone,
						month,
						rentAmount: Number(rentAmount),
						totalAmount,
						dueDate,
						status: 'pending',
						paidAmount: 0,
						createdAt: new Date().toISOString().split('T')[0],
						notes
					})
					.returning()
			)[0];

			// 2. Create Invoice Items
			await tx.insert(invoiceItems).values(
				invoiceItemList.map((item) => ({
					invoiceId: inv.id,
					name: item.name,
					amount: Number(item.amount),
					details: item.details
				}))
			);

			// 3. Update room status to debt (since invoice is pending payment)
			await tx
				.update(rooms)
				.set({
					status: 'debt',
					debtAmount: sql`coalesce(${rooms.debtAmount}, 0) + ${totalAmount}`
				})
				.where(eq(rooms.id, roomId));

			return inv;
		});

		const fullInvoice = await db.query.invoices.findFirst({
			where: eq(invoices.id, invoice.id),
			with: { items: true }
		});

		return json(fullInvoice);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const ids: string[] = Array.isArray(body.ids)
			? body.ids.filter((id: unknown): id is string => typeof id === 'string')
			: [];
		if (ids.length === 0) {
			return json({ error: 'Chưa chọn hóa đơn để xóa' }, { status: 400 });
		}

		const ownedInvoices = await db.query.invoices.findMany({
			where: inArray(invoices.id, ids),
			with: { room: { with: { property: { columns: { landlordId: true } } } } }
		});
		if (ownedInvoices.length !== ids.length) {
			return json({ error: 'Một số hóa đơn không tồn tại' }, { status: 404 });
		}
		if (ownedInvoices.some((invoice) => invoice.room.property.landlordId !== auth.value)) {
			return forbidden();
		}

		await db.transaction(async (tx) => {
			for (const invoice of ownedInvoices) {
				await tx.delete(invoices).where(eq(invoices.id, invoice.id));
				if (invoice.status !== 'paid') {
					const outstanding = Math.max(invoice.totalAmount - invoice.paidAmount, 0);
					await tx
						.update(rooms)
						.set({
							debtAmount: sql`greatest(coalesce(${rooms.debtAmount}, 0) - ${outstanding}, 0)`
						})
						.where(eq(rooms.id, invoice.roomId));
				}
			}
		});

		return json({ success: true, count: ownedInvoices.length });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
