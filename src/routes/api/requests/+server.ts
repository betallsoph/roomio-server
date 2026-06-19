import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { maintenanceRequests, rooms, properties } from '$lib/server/db/schema';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { forbidden } from '$lib/server/authz';

async function landlordOwnsRequest(landlordId: string, requestId: string) {
	const row = await db
		.select({ id: maintenanceRequests.id })
		.from(maintenanceRequests)
		.innerJoin(rooms, eq(maintenanceRequests.tenantId, rooms.tenantId))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(maintenanceRequests.id, requestId), eq(properties.landlordId, landlordId)))
		.limit(1);
	return row.length > 0;
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');
		const staffId = url.searchParams.get('staffId');

		const conditions = [];

		if (landlordId) {
			// Requests from tenants currently renting one of the landlord's rooms
			conditions.push(
				inArray(
					maintenanceRequests.tenantId,
					db
						.select({ id: rooms.tenantId })
						.from(rooms)
						.innerJoin(properties, eq(rooms.propertyId, properties.id))
						.where(and(eq(properties.landlordId, landlordId), isNotNull(rooms.tenantId)))
				)
			);
		} else if (tenantId) {
			conditions.push(eq(maintenanceRequests.tenantId, tenantId));
		}

		// Lọc theo nhân viên được giao — dùng cho cổng /staff
		if (staffId) {
			conditions.push(eq(maintenanceRequests.assignedToId, staffId));
		}

		const requests = await db.query.maintenanceRequests.findMany({
			where: conditions.length > 0 ? and(...conditions) : undefined,
			with: {
				tenant: {
					with: {
						user: {
							columns: { name: true, phone: true }
						}
					}
				},
				assignedTo: {
					with: {
						user: {
							columns: { name: true, phone: true }
						}
					}
				}
			},
			orderBy: desc(maintenanceRequests.createdAt)
		});

		return json(requests);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { tenantId, roomNumber, buildingName, category, title, description, imageUrl, priority } =
			body;
		const effectiveTenantId =
			locals.session?.role === 'TENANT' ? locals.session.tenantProfileId : tenantId;

		if (!effectiveTenantId || !roomNumber || !buildingName || !category || !title || !description) {
			return json({ error: 'Missing required maintenance request fields' }, { status: 400 });
		}
		if (locals.session?.role === 'TENANT' && tenantId && tenantId !== locals.session.tenantProfileId) {
			return forbidden();
		}

		const created = await db
			.insert(maintenanceRequests)
			.values({
				tenantId: effectiveTenantId,
				roomNumber,
				buildingName,
				category,
				title,
				description,
				imageUrl,
				priority: priority || 'normal',
				status: 'pending'
			})
			.returning();

		return json(created[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { id, status, response, assignedToId } = body;

		if (!id) {
			return json({ error: 'Missing maintenance request ID' }, { status: 400 });
		}

		// Nhân viên chỉ được cập nhật sự cố đã giao cho mình
		if (locals.session?.role === 'STAFF') {
			const existing = await db.query.maintenanceRequests.findFirst({
				where: eq(maintenanceRequests.id, id)
			});
			if (!existing || existing.assignedToId !== locals.session.staffProfileId) {
				return json({ error: 'Bạn chỉ được cập nhật sự cố được giao cho mình' }, { status: 403 });
			}
		}
		if (
			locals.session?.role === 'LANDLORD' &&
			!(await landlordOwnsRequest(locals.session.landlordProfileId!, id))
		) {
			return forbidden();
		}

		const updateData: Record<string, unknown> = {};
		if (status !== undefined) updateData.status = status;
		if (response !== undefined) updateData.response = response;
		// Chỉ chủ trọ được đổi người phụ trách; nhân viên không tự giao việc cho mình
		if (assignedToId !== undefined && locals.session?.role !== 'STAFF') {
			updateData.assignedToId = assignedToId;
		}

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		const updated = await db
			.update(maintenanceRequests)
			.set(updateData)
			.where(eq(maintenanceRequests.id, id))
			.returning();

		return json(updated[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing maintenance request ID' }, { status: 400 });
		}
		if (
			locals.session?.role !== 'LANDLORD' ||
			!(await landlordOwnsRequest(locals.session.landlordProfileId!, id))
		) {
			return forbidden();
		}

		await db.delete(maintenanceRequests).where(eq(maintenanceRequests.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
