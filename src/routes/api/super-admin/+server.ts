import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async () => {
	try {
		const landlords = await db.query.landlordProfiles.findMany({
			with: {
				user: {
					columns: { id: true, name: true, email: true, phone: true, isActive: true }
				},
				properties: {
					columns: { id: true, name: true },
					with: {
						rooms: { columns: { id: true } }
					}
				}
			}
		});

		// Keep the same response shape as before: properties expose a room count instead of the room list
		const result = landlords
			.map((landlord) => ({
				...landlord,
				properties: landlord.properties.map((property) => ({
					id: property.id,
					name: property.name,
					_count: { rooms: property.rooms.length }
				}))
			}))
			.sort((a, b) => a.user.name.localeCompare(b.user.name, 'vi'));

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { landlordId, userId, subscriptionType, isActive, subValidUntil } = body;

		if (!landlordId && !userId) {
			return json({ error: 'Missing landlord ID or user ID' }, { status: 400 });
		}

		const updated = await db.transaction(async (tx) => {
			let profile = null;
			let user = null;

			if (landlordId) {
				const updateData: Record<string, unknown> = {};
				if (subscriptionType !== undefined) updateData.subscriptionType = subscriptionType;
				if (subValidUntil) updateData.subValidUntil = new Date(subValidUntil);

				if (Object.keys(updateData).length > 0) {
					profile = (
						await tx
							.update(landlordProfiles)
							.set(updateData)
							.where(eq(landlordProfiles.id, landlordId))
							.returning()
					)[0];
				}
			}

			if (userId && isActive !== undefined) {
				user = (
					await tx.update(users).set({ isActive }).where(eq(users.id, userId)).returning()
				)[0];
			}

			return { profile, user };
		});

		return json(updated);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
