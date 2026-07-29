import { and, eq, isNull } from 'drizzle-orm';
import { staffPermissions, staffPropertyAssignments } from '$lib/server/db/schema';
import type { db as AppDb } from '$lib/server/db';
import { STAFF_PERMISSIONS, type StaffActor, type StaffPermission } from './actor.js';

/**
 * AUTH-005 — assignment/capability primitives.
 * Room/meter/request SQL scoping for endpoints is AUTH-008; keep STAFF_ALLOWLIST as a
 * temporary outer gate until those routes migrate.
 */

type StaffScopeDb = Pick<typeof AppDb, 'query'>;

/** True when `value` is a canonical staff capability string (no wildcards). */
export function isStaffCapability(value: string): value is StaffPermission {
	if (value === '*') return false;
	return (STAFF_PERMISSIONS as readonly string[]).includes(value);
}

export function assertStaffCapability(value: string): StaffPermission {
	if (!isStaffCapability(value)) {
		throw new Error(`Invalid staff permission: ${value}`);
	}
	return value;
}

/**
 * Filter unknown/wildcard values, drop duplicates, and order by `STAFF_PERMISSIONS`
 * (VIEW_* before MANAGE_*) — never alphabetical.
 */
export function normalizeStaffPermissions(values: readonly string[]): StaffPermission[] {
	const seen = new Set<StaffPermission>();
	for (const value of values) {
		if (isStaffCapability(value)) {
			seen.add(value);
		}
	}
	return STAFF_PERMISSIONS.filter((permission) => seen.has(permission));
}

export async function loadActiveStaffPropertyIds(
	database: StaffScopeDb,
	staffId: string
): Promise<string[]> {
	const rows = await database.query.staffPropertyAssignments.findMany({
		where: and(
			eq(staffPropertyAssignments.staffId, staffId),
			isNull(staffPropertyAssignments.revokedAt)
		),
		columns: { propertyId: true }
	});
	return rows.map((row) => row.propertyId);
}

export async function loadActiveStaffPermissions(
	database: StaffScopeDb,
	staffId: string
): Promise<StaffPermission[]> {
	const rows = await database.query.staffPermissions.findMany({
		where: and(eq(staffPermissions.staffId, staffId), isNull(staffPermissions.revokedAt)),
		columns: { permission: true }
	});
	return normalizeStaffPermissions(rows.map((row) => row.permission));
}

export function staffHasProperty(actor: StaffActor, propertyId: string): boolean {
	return actor.propertyIds.includes(propertyId);
}

export function staffHasPermission(actor: StaffActor, permission: StaffPermission): boolean {
	return actor.permissions.includes(permission);
}

/** Aliases used by early AUTH-005 tests. */
export const staffHasPropertyAccess = staffHasProperty;
export const staffHasCapability = staffHasPermission;
