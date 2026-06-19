import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { expenses } from '$lib/server/db/schema';
import { and, desc, eq, like } from 'drizzle-orm';
import { forbidden, landlordOwnsProperty, requireLandlord } from '$lib/server/authz';

async function landlordOwnsExpense(landlordId: string, expenseId: string) {
	const expense = await db.query.expenses.findFirst({
		where: and(eq(expenses.id, expenseId), eq(expenses.landlordId, landlordId)),
		columns: { id: true }
	});
	return !!expense;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;
		const month = url.searchParams.get('month'); // YYYY-MM

		const conditions = [eq(expenses.landlordId, landlordId)];
		if (month) {
			conditions.push(like(expenses.date, `${month}%`));
		}

		const result = await db.query.expenses.findMany({
			where: and(...conditions),
			with: {
				property: { columns: { name: true, shortName: true } }
			},
			orderBy: desc(expenses.date)
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
		const landlordId = auth.value;

		const body = await request.json();
		const { propertyId, category, description, amount, date, notes } = body;

		if (!landlordId || !category || !description || amount === undefined || !date) {
			return json({ error: 'Thiếu thông tin chi phí bắt buộc' }, { status: 400 });
		}
		if (propertyId && !(await landlordOwnsProperty(landlordId, propertyId))) {
			return forbidden();
		}

		const created = await db
			.insert(expenses)
			.values({
				landlordId,
				propertyId: propertyId || null,
				category,
				description,
				amount: Number(amount),
				date,
				notes: notes || null
			})
			.returning();

		return json(created[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const { id, propertyId, category, description, amount, date, notes } = body;

		if (!id) {
			return json({ error: 'Missing expense ID' }, { status: 400 });
		}
		if (!(await landlordOwnsExpense(auth.value, id))) {
			return forbidden();
		}
		if (propertyId && !(await landlordOwnsProperty(auth.value, propertyId))) {
			return forbidden();
		}

		const updateData: Record<string, unknown> = {};
		if (propertyId !== undefined) updateData.propertyId = propertyId || null;
		if (category !== undefined) updateData.category = category;
		if (description !== undefined) updateData.description = description;
		if (amount !== undefined) updateData.amount = Number(amount);
		if (date !== undefined) updateData.date = date;
		if (notes !== undefined) updateData.notes = notes;

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		const updated = await db
			.update(expenses)
			.set(updateData)
			.where(eq(expenses.id, id))
			.returning();

		return json(updated[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing expense ID' }, { status: 400 });
		}
		if (!(await landlordOwnsExpense(auth.value, id))) {
			return forbidden();
		}

		await db.delete(expenses).where(eq(expenses.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
