import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, properties, rooms } from '$lib/server/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requireLandlord } from '$lib/server/authz';

// Duyệt hóa đơn NHÁP → 'pending': lúc này mới tính công nợ + khách mới thấy.
// Nhận { ids: string[] } hoặc { propertyId, month } để duyệt cả tòa/tháng.
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;

		const body = await request.json();
		const ids: string[] = Array.isArray(body.ids)
			? body.ids.filter((x: unknown): x is string => typeof x === 'string')
			: [];
		const propertyId = typeof body.propertyId === 'string' ? body.propertyId : null;
		const month = typeof body.month === 'string' ? body.month : null;

		// Chỉ đụng hóa đơn nháp thuộc phòng của chủ trọ này
		const landlordRoomIds = db
			.select({ id: rooms.id })
			.from(rooms)
			.innerJoin(properties, eq(rooms.propertyId, properties.id))
			.where(eq(properties.landlordId, landlordId));

		const conditions = [eq(invoices.status, 'draft'), inArray(invoices.roomId, landlordRoomIds)];
		if (ids.length) {
			conditions.push(inArray(invoices.id, ids));
		} else if (propertyId && month) {
			conditions.push(eq(invoices.month, month));
			conditions.push(
				inArray(
					invoices.roomId,
					db.select({ id: rooms.id }).from(rooms).where(eq(rooms.propertyId, propertyId))
				)
			);
		} else {
			return json({ error: 'Cần chọn hóa đơn (ids) hoặc propertyId + month' }, { status: 400 });
		}

		const drafts = await db.query.invoices.findMany({
			where: and(...conditions),
			columns: { id: true, roomId: true, totalAmount: true, month: true }
		});
		if (drafts.length === 0) {
			return json({ success: true, count: 0 });
		}

		await db.transaction(async (tx) => {
			for (const d of drafts) {
				await tx
					.update(invoices)
					.set({ status: 'pending', notes: `Hóa đơn tháng ${d.month}` })
					.where(eq(invoices.id, d.id));
				// Giờ mới tính công nợ (nháp trước đó không đụng nợ)
				await tx
					.update(rooms)
					.set({
						status: 'debt',
						debtAmount: sql`coalesce(${rooms.debtAmount}, 0) + ${d.totalAmount}`
					})
					.where(eq(rooms.id, d.roomId));
			}
		});

		return json({ success: true, count: drafts.length });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
