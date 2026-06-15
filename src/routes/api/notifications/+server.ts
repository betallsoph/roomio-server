import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { specialNotes, rooms, properties } from '$lib/server/db/schema';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');

		const conditions = [];

		if (landlordId) {
			conditions.push(
				inArray(
					specialNotes.tenantId,
					db
						.select({ id: rooms.tenantId })
						.from(rooms)
						.innerJoin(properties, eq(rooms.propertyId, properties.id))
						.where(and(eq(properties.landlordId, landlordId), isNotNull(rooms.tenantId)))
				)
			);
		} else if (tenantId) {
			conditions.push(eq(specialNotes.tenantId, tenantId));
		}

		const notes = await db.query.specialNotes.findMany({
			where: conditions.length > 0 ? and(...conditions) : undefined,
			with: {
				tenant: {
					with: {
						user: {
							columns: { name: true, phone: true }
						},
						rooms: {
							columns: { roomNumber: true }
						}
					}
				}
			},
			orderBy: desc(specialNotes.createdAt)
		});

		return json(notes);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { tenantId, content, sender } = body;

		if (!tenantId || !content) {
			return json({ error: 'Missing tenant ID or content' }, { status: 400 });
		}

		const created = await db
			.insert(specialNotes)
			.values({
				tenantId,
				content,
				sender: sender === 'LANDLORD' ? 'LANDLORD' : 'TENANT',
				isRead: false
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
		const { id, isRead } = body;

		if (!id) {
			return json({ error: 'Missing notification/note ID' }, { status: 400 });
		}

		const updated = await db
			.update(specialNotes)
			.set({ isRead: isRead !== undefined ? isRead : true })
			.where(eq(specialNotes.id, id))
			.returning();

		return json(updated[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
