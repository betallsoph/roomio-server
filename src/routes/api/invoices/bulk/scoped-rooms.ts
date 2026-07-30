import { and, eq, inArray } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { properties, rooms } from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import { operationsNotFound } from '$lib/server/operations/errors';

type FinanceDb = typeof AppDb;

/**
 * AUTH-012 §6 — every room id must belong to the landlord-owned property; unique count must match.
 */
export async function validateScopedRoomIdsForProperty(
	database: FinanceDb,
	actor: LandlordActor,
	propertyId: string,
	roomIds: string[]
): Promise<void> {
	if (roomIds.length === 0) {
		return;
	}
	const uniqueIds = [...new Set(roomIds.map(String))];
	const scoped = await database
		.select({ id: rooms.id })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				eq(properties.id, propertyId),
				eq(properties.landlordId, actor.landlordId),
				inArray(rooms.id, uniqueIds)
			)
		);
	if (scoped.length !== uniqueIds.length) {
		throw operationsNotFound('Một hoặc nhiều phòng không tồn tại hoặc không thuộc tòa nhà này');
	}
}
