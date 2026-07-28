import { STAFF_PERMISSIONS, type StaffActor, type StaffPermission } from './actor.js';

/** True when `value` is a canonical staff capability string (no wildcards). */
export function isStaffCapability(value: string): value is StaffPermission {
	if (value === '*') return false;
	return (STAFF_PERMISSIONS as readonly string[]).includes(value);
}

export function staffHasPropertyAccess(actor: StaffActor, propertyId: string): boolean {
	return actor.propertyIds.includes(propertyId);
}

export function staffHasCapability(actor: StaffActor, permission: StaffPermission): boolean {
	return actor.permissions.includes(permission);
}
