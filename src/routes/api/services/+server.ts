import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { services, rooms, properties, roomServiceConfigs } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');

		if (!landlordId) {
			return json({ error: 'Missing landlord ID' }, { status: 400 });
		}

		const result = await db
			.select()
			.from(services)
			.where(eq(services.landlordId, landlordId))
			.orderBy(asc(services.name));

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { landlordId, name, type, defaultRate, isActive } = body;

		if (!landlordId || !name || !type || defaultRate === undefined) {
			return json({ error: 'Missing required service fields' }, { status: 400 });
		}

		const service = await db.transaction(async (tx) => {
			const created = (
				await tx
					.insert(services)
					.values({
						landlordId,
						name,
						type, // "METERED" | "FLAT_ROOM" | "FLAT_PERSON" | "FLAT_VEHICLE"
						defaultRate: Number(defaultRate),
						isActive: isActive !== undefined ? isActive : true
					})
					.returning()
			)[0];

			// Automatically register this new service for all existing rooms belonging to this landlord
			const landlordRooms = await tx
				.select({ id: rooms.id })
				.from(rooms)
				.innerJoin(properties, eq(rooms.propertyId, properties.id))
				.where(eq(properties.landlordId, landlordId));
			if (landlordRooms.length > 0) {
				await tx.insert(roomServiceConfigs).values(
					landlordRooms.map((room) => ({
						roomId: room.id,
						serviceId: created.id,
						customRate: null,
						quantity: 1
					}))
				);
			}

			return created;
		});

		return json(service);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { id, name, defaultRate, isActive } = body;

		if (!id) {
			return json({ error: 'Missing service ID' }, { status: 400 });
		}

		const updateData: Record<string, unknown> = {};
		if (name !== undefined) updateData.name = name;
		if (defaultRate !== undefined) updateData.defaultRate = Number(defaultRate);
		if (isActive !== undefined) updateData.isActive = isActive;

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		const updated = await db
			.update(services)
			.set(updateData)
			.where(eq(services.id, id))
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
			return json({ error: 'Missing service ID' }, { status: 400 });
		}

		await db.delete(services).where(eq(services.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
