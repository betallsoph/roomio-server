import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { expenses } from '$lib/server/db/schema';
import { and, desc, eq, like } from 'drizzle-orm';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';
import { toExpenseDto, toExpenseListDto } from '$lib/server/dto/expenses';
import {
	propertyScopeErrorToResponse,
	requireLandlordMutationActor,
	requireScopedProperty
} from '$lib/server/property-scope';

async function landlordOwnsExpense(landlordId: string, expenseId: string) {
	const expense = await db.query.expenses.findFirst({
		where: and(eq(expenses.id, expenseId), eq(expenses.landlordId, landlordId)),
		columns: { id: true }
	});
	return !!expense;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;
		const month = url.searchParams.get('month');

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

		return json(toExpenseListDto(result));
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const body = await request.json();
		const { propertyId, category, description, amount, date, notes } = body;

		if (!category || !description || amount === undefined || !date) {
			return json({ error: 'Thiếu thông tin chi phí bắt buộc' }, { status: 400 });
		}

		let resolvedPropertyId: string | null = null;
		if (propertyId) {
			await requireScopedProperty(db, actorResult.actor, String(propertyId));
			resolvedPropertyId = String(propertyId);
		}

		const created = await db
			.insert(expenses)
			.values({
				landlordId,
				propertyId: resolvedPropertyId,
				category,
				description,
				amount: Number(amount),
				date,
				notes: notes || null
			})
			.returning();

		const withProperty = await db.query.expenses.findFirst({
			where: eq(expenses.id, created[0].id),
			with: { property: { columns: { name: true, shortName: true } } }
		});
		return json(toExpenseDto(withProperty ?? created[0]));
	} catch (error) {
		if (error instanceof ScopedResourceNotFoundError) {
			return json({ error: 'Không tìm thấy dữ liệu' }, { status: 404 });
		}
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const body = await request.json();
		const { id, propertyId, category, description, amount, date, notes } = body;

		if (!id) {
			return json({ error: 'Missing expense ID' }, { status: 400 });
		}
		if (!(await landlordOwnsExpense(landlordId, id))) {
			return json({ error: 'Không tìm thấy dữ liệu' }, { status: 404 });
		}

		const updateData: Record<string, unknown> = {};
		if (propertyId !== undefined) {
			if (propertyId) {
				await requireScopedProperty(db, actorResult.actor, String(propertyId));
				updateData.propertyId = String(propertyId);
			} else {
				updateData.propertyId = null;
			}
		}
		if (category !== undefined) updateData.category = category;
		if (description !== undefined) updateData.description = description;
		if (amount !== undefined) updateData.amount = Number(amount);
		if (date !== undefined) updateData.date = date;
		if (notes !== undefined) updateData.notes = notes;

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		await db.update(expenses).set(updateData).where(eq(expenses.id, id));

		const updated = await db.query.expenses.findFirst({
			where: eq(expenses.id, id),
			with: { property: { columns: { name: true, shortName: true } } }
		});
		if (!updated) {
			return json({ error: 'Không tìm thấy dữ liệu' }, { status: 404 });
		}

		return json(toExpenseDto(updated));
	} catch (error) {
		if (error instanceof ScopedResourceNotFoundError) {
			return json({ error: 'Không tìm thấy dữ liệu' }, { status: 404 });
		}
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const id = url.searchParams.get('id');
		if (!id) {
			return json({ error: 'Missing expense ID' }, { status: 400 });
		}
		if (!(await landlordOwnsExpense(landlordId, id))) {
			return json({ error: 'Không tìm thấy dữ liệu' }, { status: 404 });
		}

		await db.delete(expenses).where(eq(expenses.id, id));
		return json({ success: true });
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
