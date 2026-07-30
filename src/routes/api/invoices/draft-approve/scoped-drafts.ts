import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { invoices, properties, rooms } from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import { findPropertyForLandlord } from '$lib/server/authorization/scoped-queries';
import { operationsNotFound, operationsValidation } from '$lib/server/operations/errors';

type FinanceDb = typeof AppDb;

export type DraftInvoiceRow = {
	id: string;
	roomId: string;
	totalAmount: number;
	month: string;
};

function landlordRoomIdsSubquery(database: FinanceDb, landlordId: string) {
	return database
		.select({ id: rooms.id })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(eq(properties.landlordId, landlordId));
}

/**
 * AUTH-012 §7 — scoped draft query; explicit ids must all resolve to landlord-owned drafts.
 */
export async function listDraftInvoicesForApprove(
	database: FinanceDb,
	actor: LandlordActor,
	input: { ids?: string[]; propertyId?: string | null; month?: string | null }
): Promise<DraftInvoiceRow[]> {
	const landlordRoomIds = landlordRoomIdsSubquery(database, actor.landlordId);
	const conditions: SQL[] = [
		eq(invoices.status, 'draft'),
		inArray(invoices.roomId, landlordRoomIds)
	];

	const ids = input.ids?.filter((id) => typeof id === 'string' && id.length > 0) ?? [];
	if (ids.length > 0) {
		const uniqueIds = [...new Set(ids)];
		conditions.push(inArray(invoices.id, uniqueIds));
		const drafts = await database.query.invoices.findMany({
			where: and(...conditions),
			columns: { id: true, roomId: true, totalAmount: true, month: true }
		});
		if (drafts.length !== uniqueIds.length) {
			throw operationsNotFound();
		}
		return drafts;
	}

	if (input.propertyId && input.month) {
		await findPropertyForLandlord(database, actor, input.propertyId);
		conditions.push(eq(invoices.month, input.month));
		conditions.push(
			inArray(
				invoices.roomId,
				database
					.select({ id: rooms.id })
					.from(rooms)
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(
						and(eq(properties.landlordId, actor.landlordId), eq(rooms.propertyId, input.propertyId))
					)
			)
		);
		return database.query.invoices.findMany({
			where: and(...conditions),
			columns: { id: true, roomId: true, totalAmount: true, month: true }
		});
	}

	throw operationsValidation('Cần chọn hóa đơn (ids) hoặc propertyId + month');
}

/** Conditional draft → pending; only rows still in draft are updated (idempotent under races). */
export async function approveDraftInvoicesConditionally(
	database: FinanceDb,
	drafts: DraftInvoiceRow[]
): Promise<number> {
	if (drafts.length === 0) {
		return 0;
	}

	let approved = 0;
	await database.transaction(async (tx) => {
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
	return approved;
}
