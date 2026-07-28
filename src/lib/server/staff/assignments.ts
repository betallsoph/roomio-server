import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db } from '$lib/server/db';
import {
	properties,
	staffPermissions,
	staffProfiles,
	staffPropertyAssignments
} from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import {
	STAFF_PERMISSIONS,
	type LandlordActor,
	type StaffPermission
} from '$lib/server/authorization/actor';
import { appendAudit, type AuditTx } from '$lib/server/audit/append';
import { auditActorFromUserActor } from '$lib/server/audit/actors';

// Room/meter/request endpoint enforcement is AUTH-008; this module only manages grants.

export type StaffDb = NodePgDatabase<typeof schema>;

export class StaffResourceNotFoundError extends Error {
	readonly status = 404 as const;

	constructor(message = 'Không tìm thấy') {
		super(message);
		this.name = 'StaffResourceNotFoundError';
	}
}

export class InvalidStaffPermissionError extends Error {
	readonly status = 422 as const;

	constructor(message = 'Quyền không hợp lệ') {
		super(message);
		this.name = 'InvalidStaffPermissionError';
	}
}

function parseStaffPermission(permission: string): StaffPermission {
	if (!(STAFF_PERMISSIONS as readonly string[]).includes(permission)) {
		throw new InvalidStaffPermissionError();
	}
	return permission as StaffPermission;
}

async function assertStaffOwnedByLandlord(staffConn: StaffDb | AuditTx, staffId: string, landlordId: string) {
	const staff = await staffConn.query.staffProfiles.findFirst({
		where: and(eq(staffProfiles.id, staffId), eq(staffProfiles.landlordId, landlordId))
	});
	if (!staff) {
		throw new StaffResourceNotFoundError();
	}
	return staff;
}

async function assertPropertyOwnedByLandlord(staffConn: StaffDb | AuditTx, propertyId: string, landlordId: string) {
	const property = await staffConn.query.properties.findFirst({
		where: and(eq(properties.id, propertyId), eq(properties.landlordId, landlordId))
	});
	if (!property) {
		throw new StaffResourceNotFoundError();
	}
	return property;
}

async function withStaffMutation<T>(
	conn: StaffDb,
	fn: (tx: AuditTx) => Promise<T>
): Promise<T> {
	return conn.transaction(fn);
}

export type StaffAssignmentsPermissions = {
	propertyIds: string[];
	permissions: StaffPermission[];
};

export async function listStaffAssignmentsPermissions(
	staffId: string,
	landlordId: string,
	conn: StaffDb = db
): Promise<StaffAssignmentsPermissions> {
	await assertStaffOwnedByLandlord(conn, staffId, landlordId);

	const [assignments, permissionRows] = await Promise.all([
		conn.query.staffPropertyAssignments.findMany({
			where: and(
				eq(staffPropertyAssignments.staffId, staffId),
				isNull(staffPropertyAssignments.revokedAt)
			),
			columns: { propertyId: true }
		}),
		conn.query.staffPermissions.findMany({
			where: and(eq(staffPermissions.staffId, staffId), isNull(staffPermissions.revokedAt)),
			columns: { permission: true }
		})
	]);

	return {
		propertyIds: assignments.map((row) => row.propertyId),
		permissions: permissionRows.map((row) => row.permission as StaffPermission)
	};
}

export type PropertyAssignmentRow = typeof staffPropertyAssignments.$inferSelect;
export type StaffPermissionRow = typeof staffPermissions.$inferSelect;

export type MutationOutcome<T> = { changed: boolean; value: T };

async function assignStaffPropertyTx(
	tx: AuditTx,
	actor: LandlordActor,
	input: { staffId: string; propertyId: string }
): Promise<MutationOutcome<PropertyAssignmentRow>> {
	const { staffId, propertyId } = input;
	const landlordId = actor.landlordId;

	await assertStaffOwnedByLandlord(tx, staffId, landlordId);
	await assertPropertyOwnedByLandlord(tx, propertyId, landlordId);

	const existing = await tx.query.staffPropertyAssignments.findFirst({
		where: and(
			eq(staffPropertyAssignments.staffId, staffId),
			eq(staffPropertyAssignments.propertyId, propertyId),
			isNull(staffPropertyAssignments.revokedAt)
		)
	});
	if (existing) {
		return { changed: false, value: existing };
	}

	const inserted = (
		await tx
			.insert(staffPropertyAssignments)
			.values({
				staffId,
				propertyId,
				assignedByUserId: actor.userId
			})
			.returning()
	)[0];

	await appendAudit(tx, auditActorFromUserActor(actor), {
		scope: 'LANDLORD',
		action: 'STAFF.PROPERTY_ASSIGNED',
		resourceType: 'StaffPropertyAssignment',
		resourceId: inserted.id,
		landlordId,
		metadata: { staffId, propertyId }
	});

	return { changed: true, value: inserted };
}

export async function assignStaffProperty(
	conn: StaffDb,
	actor: LandlordActor,
	input: { staffId: string; propertyId: string }
): Promise<MutationOutcome<PropertyAssignmentRow>> {
	return withStaffMutation(conn, (tx) => assignStaffPropertyTx(tx, actor, input));
}

async function revokeStaffPropertyTx(
	tx: AuditTx,
	actor: LandlordActor,
	input: { staffId: string; propertyId: string }
): Promise<MutationOutcome<PropertyAssignmentRow | null>> {
	const { staffId, propertyId } = input;
	const landlordId = actor.landlordId;

	await assertStaffOwnedByLandlord(tx, staffId, landlordId);
	await assertPropertyOwnedByLandlord(tx, propertyId, landlordId);

	const active = await tx.query.staffPropertyAssignments.findFirst({
		where: and(
			eq(staffPropertyAssignments.staffId, staffId),
			eq(staffPropertyAssignments.propertyId, propertyId),
			isNull(staffPropertyAssignments.revokedAt)
		)
	});
	if (!active) {
		return { changed: false, value: null };
	}

	const revokedAt = new Date();
	const updated = (
		await tx
			.update(staffPropertyAssignments)
			.set({ revokedAt })
			.where(eq(staffPropertyAssignments.id, active.id))
			.returning()
	)[0];

	await appendAudit(tx, auditActorFromUserActor(actor), {
		scope: 'LANDLORD',
		action: 'STAFF.PROPERTY_REVOKED',
		resourceType: 'StaffPropertyAssignment',
		resourceId: updated.id,
		landlordId,
		metadata: { staffId, propertyId }
	});

	return { changed: true, value: updated };
}

export async function revokeStaffProperty(
	conn: StaffDb,
	actor: LandlordActor,
	input: { staffId: string; propertyId: string }
): Promise<MutationOutcome<PropertyAssignmentRow | null>> {
	return withStaffMutation(conn, (tx) => revokeStaffPropertyTx(tx, actor, input));
}

async function grantStaffPermissionTx(
	tx: AuditTx,
	actor: LandlordActor,
	input: { staffId: string; permission: StaffPermission }
): Promise<MutationOutcome<StaffPermissionRow>> {
	const { staffId, permission } = input;
	const landlordId = actor.landlordId;

	await assertStaffOwnedByLandlord(tx, staffId, landlordId);

	const existing = await tx.query.staffPermissions.findFirst({
		where: and(
			eq(staffPermissions.staffId, staffId),
			eq(staffPermissions.permission, permission),
			isNull(staffPermissions.revokedAt)
		)
	});
	if (existing) {
		return { changed: false, value: existing };
	}

	const inserted = (
		await tx
			.insert(staffPermissions)
			.values({
				staffId,
				permission,
				grantedByUserId: actor.userId
			})
			.returning()
	)[0];

	await appendAudit(tx, auditActorFromUserActor(actor), {
		scope: 'LANDLORD',
		action: 'STAFF.PERMISSION_GRANTED',
		resourceType: 'StaffPermission',
		resourceId: inserted.id,
		landlordId,
		metadata: { staffId, permission }
	});

	return { changed: true, value: inserted };
}

export async function grantStaffPermission(
	conn: StaffDb,
	actor: LandlordActor,
	input: { staffId: string; permission: string }
): Promise<MutationOutcome<StaffPermissionRow>> {
	const permission = parseStaffPermission(input.permission);
	return withStaffMutation(conn, (tx) => grantStaffPermissionTx(tx, actor, { ...input, permission }));
}

async function revokeStaffPermissionTx(
	tx: AuditTx,
	actor: LandlordActor,
	input: { staffId: string; permission: StaffPermission }
): Promise<MutationOutcome<StaffPermissionRow | null>> {
	const { staffId, permission } = input;
	const landlordId = actor.landlordId;

	await assertStaffOwnedByLandlord(tx, staffId, landlordId);

	const active = await tx.query.staffPermissions.findFirst({
		where: and(
			eq(staffPermissions.staffId, staffId),
			eq(staffPermissions.permission, permission),
			isNull(staffPermissions.revokedAt)
		)
	});
	if (!active) {
		return { changed: false, value: null };
	}

	const revokedAt = new Date();
	const updated = (
		await tx
			.update(staffPermissions)
			.set({ revokedAt })
			.where(eq(staffPermissions.id, active.id))
			.returning()
	)[0];

	await appendAudit(tx, auditActorFromUserActor(actor), {
		scope: 'LANDLORD',
		action: 'STAFF.PERMISSION_REVOKED',
		resourceType: 'StaffPermission',
		resourceId: updated.id,
		landlordId,
		metadata: { staffId, permission }
	});

	return { changed: true, value: updated };
}

export async function revokeStaffPermission(
	conn: StaffDb,
	actor: LandlordActor,
	input: { staffId: string; permission: string }
): Promise<MutationOutcome<StaffPermissionRow | null>> {
	const permission = parseStaffPermission(input.permission);
	return withStaffMutation(conn, (tx) => revokeStaffPermissionTx(tx, actor, { ...input, permission }));
}

export async function replaceStaffPermissionsAllowlist(
	conn: StaffDb,
	actor: LandlordActor,
	input: { staffId: string; permissions: string[] }
): Promise<{ granted: StaffPermission[]; revoked: StaffPermission[] }> {
	const desired = new Set<StaffPermission>();
	for (const raw of input.permissions) {
		desired.add(parseStaffPermission(raw));
	}

	const staffId = input.staffId;

	return withStaffMutation(conn, async (tx) => {
		await assertStaffOwnedByLandlord(tx, staffId, actor.landlordId);

		const activeRows = await tx.query.staffPermissions.findMany({
			where: and(eq(staffPermissions.staffId, staffId), isNull(staffPermissions.revokedAt)),
			columns: { permission: true }
		});

		const current = new Set(activeRows.map((row) => row.permission as StaffPermission));
		const toGrant = [...desired].filter((p) => !current.has(p));
		const toRevoke = [...current].filter((p) => !desired.has(p));

		const granted: StaffPermission[] = [];
		const revoked: StaffPermission[] = [];

		for (const permission of toGrant) {
			const result = await grantStaffPermissionTx(tx, actor, { staffId, permission });
			if (result.changed) {
				granted.push(permission);
			}
		}

		for (const permission of toRevoke) {
			const result = await revokeStaffPermissionTx(tx, actor, { staffId, permission });
			if (result.changed) {
				revoked.push(permission);
			}
		}

		return { granted, revoked };
	});
}
