import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import { appendAudit, type AuditTx } from '$lib/server/audit/append';
import { auditActorFromUserActor } from '$lib/server/audit/actors';
import {
	assertStaffOwnedByLandlord,
	revokeAllActiveStaffGrantsTx,
	type StaffDb
} from './assignments.js';

export type DeactivateStaffResult = {
	changed: boolean;
	userDeactivated: boolean;
	revokedAssignments: number;
	revokedPermissions: number;
};

/**
 * Soft-deactivate staff: User.isActive=false + revoke active grants.
 * Never hard-deletes User/StaffProfile or grant history rows.
 */
export async function deactivateStaffTx(
	tx: AuditTx,
	actor: LandlordActor,
	staffId: string
): Promise<DeactivateStaffResult> {
	const profile = await assertStaffOwnedByLandlord(tx, staffId, actor.landlordId);
	const grants = await revokeAllActiveStaffGrantsTx(tx, actor, staffId);

	const user = await tx.query.users.findFirst({
		where: eq(users.id, profile.userId),
		columns: { id: true, isActive: true }
	});
	if (!user) {
		throw new Error('Staff user missing');
	}

	let userDeactivated = false;
	if (user.isActive) {
		await tx.update(users).set({ isActive: false }).where(eq(users.id, user.id));
		await appendAudit(tx, auditActorFromUserActor(actor), {
			scope: 'LANDLORD',
			action: 'STAFF.DEACTIVATED',
			resourceType: 'StaffProfile',
			resourceId: staffId,
			landlordId: actor.landlordId,
			metadata: { userId: user.id }
		});
		userDeactivated = true;
	}

	return {
		changed: userDeactivated || grants.revokedAssignments > 0 || grants.revokedPermissions > 0,
		userDeactivated,
		revokedAssignments: grants.revokedAssignments,
		revokedPermissions: grants.revokedPermissions
	};
}

export async function deactivateStaff(
	conn: StaffDb = db,
	actor: LandlordActor,
	staffId: string
): Promise<DeactivateStaffResult> {
	return conn.transaction((tx) => deactivateStaffTx(tx, actor, staffId));
}
