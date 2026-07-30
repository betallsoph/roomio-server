import { and, eq, isNull } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { staffProfiles, staffPropertyAssignments } from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import { operationsNotFound } from './errors.js';

type AssigneeDb = Pick<typeof AppDb, 'select'>;

/**
 * Landlord assignee validation: staff must belong to the same landlord and be
 * actively assigned to the request property. Foreign/missing staff → 404.
 */
export async function assertStaffAssigneeForProperty(
	database: AssigneeDb,
	actor: LandlordActor,
	staffId: string,
	propertyId: string
): Promise<void> {
	const rows = await database
		.select({ id: staffProfiles.id })
		.from(staffProfiles)
		.innerJoin(
			staffPropertyAssignments,
			and(
				eq(staffPropertyAssignments.staffId, staffProfiles.id),
				eq(staffPropertyAssignments.propertyId, propertyId),
				isNull(staffPropertyAssignments.revokedAt)
			)
		)
		.where(and(eq(staffProfiles.id, staffId), eq(staffProfiles.landlordId, actor.landlordId)))
		.limit(1);

	if (!rows[0]) {
		throw operationsNotFound();
	}
}
