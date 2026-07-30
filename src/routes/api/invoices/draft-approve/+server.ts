import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, rooms } from '$lib/server/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { requireLandlordActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import { findPropertyForLandlord } from '$lib/server/authorization/scoped-queries';
import { isOperationsError, operationsNotFound } from '$lib/server/operations/errors';
import {
	listDraftInvoiceIdsForLandlord,
	mapFinanceScopeError
} from '$lib/server/operations/finance-scope';

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

// Duyệt hóa đơn NHÁP → 'pending': lúc này mới tính công nợ + khách mới thấy.
// Nhận { ids: string[] } hoặc { propertyId, month } để duyệt cả tòa/tháng.
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;
		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(landlord.error);
		}
		const actor = landlord.value;

		const body = await request.json();
		const ids: string[] = Array.isArray(body.ids)
			? body.ids.filter((x: unknown): x is string => typeof x === 'string')
			: [];
		const propertyId = typeof body.propertyId === 'string' ? body.propertyId : null;
		const month = typeof body.month === 'string' ? body.month : null;

		let drafts;
		if (ids.length > 0) {
			const uniqueIds = [...new Set(ids)];
			drafts = await listDraftInvoiceIdsForLandlord(db, actor, { ids: uniqueIds });
			if (drafts.length !== uniqueIds.length) {
				throw operationsNotFound();
			}
		} else if (propertyId && month) {
			await findPropertyForLandlord(db, actor, propertyId);
			drafts = await listDraftInvoiceIdsForLandlord(db, actor, { propertyId, month });
		} else {
			drafts = await listDraftInvoiceIdsForLandlord(db, actor, { ids: [] });
		}

		if (drafts.length === 0) {
			return json({ success: true, count: 0 });
		}

		let approved = 0;
		await db.transaction(async (tx) => {
			for (const d of drafts) {
				const updated = await tx
					.update(invoices)
					.set({ status: 'pending', notes: `Hóa đơn tháng ${d.month}` })
					.where(and(eq(invoices.id, d.id), eq(invoices.status, 'draft')))
					.returning({ id: invoices.id });
				if (updated.length === 0) {
					continue;
				}
				approved += 1;
				await tx
					.update(rooms)
					.set({
						status: 'debt',
						debtAmount: sql`coalesce(${rooms.debtAmount}, 0) + ${d.totalAmount}`
					})
					.where(eq(rooms.id, d.roomId));
			}
		});

		return json({ success: true, count: approved });
	} catch (error) {
		return mapHandlerError(error);
	}
};
