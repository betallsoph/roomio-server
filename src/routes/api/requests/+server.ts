import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { maintenanceRequests, rooms, properties } from '$lib/server/db/schema';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');

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

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { tenantId, roomNumber, buildingName, category, title, description, imageUrl, priority } =
			body;

		if (!tenantId || !roomNumber || !buildingName || !category || !title || !description) {
			return json({ error: 'Missing required maintenance request fields' }, { status: 400 });
		}

		const created = await db
			.insert(maintenanceRequests)
			.values({
				tenantId,
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

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { id, status, response, assignedToId } = body;

		if (!id) {
			return json({ error: 'Missing maintenance request ID' }, { status: 400 });
		}

		const updateData: Record<string, unknown> = {};
		if (status !== undefined) updateData.status = status;
		if (response !== undefined) updateData.response = response;
		if (assignedToId !== undefined) updateData.assignedToId = assignedToId;

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

export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing maintenance request ID' }, { status: 400 });
		}

		await db.delete(maintenanceRequests).where(eq(maintenanceRequests.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
