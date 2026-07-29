import type { StaffPermission } from '$lib/server/authorization/actor';

/** Public assignment fields — never expose assignedByUserId. */
export type StaffPropertyAssignmentDto = {
	id: string;
	staffId: string;
	propertyId: string;
	createdAt: Date;
	revokedAt: Date | null;
};

/** Public permission fields — never expose grantedByUserId. */
export type StaffPermissionDto = {
	id: string;
	staffId: string;
	permission: StaffPermission;
	createdAt: Date;
	revokedAt: Date | null;
};

export function toStaffPropertyAssignmentDto(row: {
	id: string;
	staffId: string;
	propertyId: string;
	createdAt: Date;
	revokedAt: Date | null;
}): StaffPropertyAssignmentDto {
	return {
		id: row.id,
		staffId: row.staffId,
		propertyId: row.propertyId,
		createdAt: row.createdAt,
		revokedAt: row.revokedAt
	};
}

export function toStaffPermissionDto(row: {
	id: string;
	staffId: string;
	permission: string;
	createdAt: Date;
	revokedAt: Date | null;
}): StaffPermissionDto {
	return {
		id: row.id,
		staffId: row.staffId,
		permission: row.permission as StaffPermission,
		createdAt: row.createdAt,
		revokedAt: row.revokedAt
	};
}
