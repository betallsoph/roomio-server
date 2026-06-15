import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { contracts, rooms, properties } from '$lib/server/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');

		let condition;
		if (landlordId) {
			condition = inArray(
				contracts.roomId,
				db
					.select({ id: rooms.id })
					.from(rooms)
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(eq(properties.landlordId, landlordId))
			);
		} else if (tenantId) {
			condition = eq(contracts.tenantId, tenantId);
		} else {
			return json({ error: 'Missing landlordId or tenantId' }, { status: 400 });
		}

		const result = await db.query.contracts.findMany({
			where: condition,
			with: {
				tenant: { with: { user: { columns: { name: true, phone: true } } } },
				room: { with: { property: { columns: { name: true, shortName: true } } } }
			},
			orderBy: desc(contracts.createdAt)
		});

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { tenantId, roomId, startDate, endDate, monthlyRent, deposit, fileUrl, notes } = body;

		if (!tenantId || !roomId || !startDate || !endDate || monthlyRent === undefined) {
			return json({ error: 'Thiếu thông tin hợp đồng bắt buộc' }, { status: 400 });
		}

		const created = await db
			.insert(contracts)
			.values({
				tenantId,
				roomId,
				startDate,
				endDate,
				monthlyRent: Number(monthlyRent),
				deposit: deposit !== undefined ? Number(deposit) : 0,
				fileUrl: fileUrl || null,
				notes: notes || null,
				status: 'active'
			})
			.returning();

		return json(created[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { id, startDate, endDate, monthlyRent, deposit, fileUrl, notes, status } = body;

		if (!id) {
			return json({ error: 'Missing contract ID' }, { status: 400 });
		}

		const updateData: Record<string, unknown> = {};
		if (startDate !== undefined) updateData.startDate = startDate;
		if (endDate !== undefined) updateData.endDate = endDate;
		if (monthlyRent !== undefined) updateData.monthlyRent = Number(monthlyRent);
		if (deposit !== undefined) updateData.deposit = Number(deposit);
		if (fileUrl !== undefined) updateData.fileUrl = fileUrl;
		if (notes !== undefined) updateData.notes = notes;
		if (status !== undefined) updateData.status = status; // 'active' | 'expired' | 'terminated'

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		const updated = await db
			.update(contracts)
			.set(updateData)
			.where(eq(contracts.id, id))
			.returning();

		return json(updated[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing contract ID' }, { status: 400 });
		}

		await db.delete(contracts).where(eq(contracts.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
