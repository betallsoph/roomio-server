/**
 * AUTH-011 — role-specific managed-tenant directory DTOs.
 * `tenantId` in API paths/responses refers to ManagedTenant.id.
 */

export type ActiveTenancySummaryDto = {
	tenancyId: string;
	propertyId: string;
	roomId: string;
	roomLabel: string;
	startDate: string;
};

export type TenantSummaryForLandlordDto = {
	/** ManagedTenant.id — API compatibility alias `tenantId`. */
	id: string;
	tenantId: string;
	displayName: string;
	emailSnapshot: string | null;
	phoneSnapshot: string | null;
	isClaimed: boolean;
	activeTenancy: ActiveTenancySummaryDto | null;
	createdAt: string;
};

export type TenantSummaryForStaffDto = {
	id: string;
	tenantId: string;
	displayName: string;
	phoneSnapshot: string | null;
	roomLabel: string | null;
	activeTenancyId: string | null;
};

export type TenantSelfManagedTenantDto = {
	id: string;
	tenantId: string;
	displayName: string;
	landlordId: string;
	activeTenancies: ActiveTenancySummaryDto[];
};

export type TenantSelfDto = {
	identity: {
		id: string;
		name: string;
		email: string | null;
		phone: string | null;
	};
	managedTenants: TenantSelfManagedTenantDto[];
};

export type ManagedTenantDetailForLandlordDto = TenantSummaryForLandlordDto & {
	legacyTenantProfileId: string | null;
};

export type ManagedTenantDetailForStaffDto = TenantSummaryForStaffDto;

export type ManagedTenantDetailForTenantDto = {
	id: string;
	tenantId: string;
	displayName: string;
	landlordId: string;
	activeTenancies: ActiveTenancySummaryDto[];
	profile: {
		idNumber: string | null;
		idFrontImage: string | null;
		idBackImage: string | null;
		vehicleImage: string | null;
		checkInImage: string | null;
	} | null;
};

function roomLabel(roomNumber: string, roomCode: string | null): string {
	return roomCode?.trim() ? roomCode : roomNumber;
}

export function toActiveTenancySummaryDto(row: {
	tenancyId: string;
	propertyId: string;
	roomId: string;
	roomNumber: string;
	roomCode: string | null;
	startDate: string;
}): ActiveTenancySummaryDto {
	return {
		tenancyId: row.tenancyId,
		propertyId: row.propertyId,
		roomId: row.roomId,
		roomLabel: roomLabel(row.roomNumber, row.roomCode),
		startDate: row.startDate
	};
}

export function toTenantSummaryForLandlordDto(row: {
	id: string;
	displayName: string;
	emailSnapshot: string | null;
	phoneSnapshot: string | null;
	claimedByUserId: string | null;
	createdAt: Date;
	activeTenancy: ActiveTenancySummaryDto | null;
}): TenantSummaryForLandlordDto {
	return {
		id: row.id,
		tenantId: row.id,
		displayName: row.displayName,
		emailSnapshot: row.emailSnapshot,
		phoneSnapshot: row.phoneSnapshot,
		isClaimed: row.claimedByUserId !== null,
		activeTenancy: row.activeTenancy,
		createdAt: row.createdAt.toISOString()
	};
}

export function toTenantSummaryForStaffDto(row: {
	id: string;
	displayName: string;
	phoneSnapshot: string | null;
	activeTenancy: ActiveTenancySummaryDto | null;
}): TenantSummaryForStaffDto {
	return {
		id: row.id,
		tenantId: row.id,
		displayName: row.displayName,
		phoneSnapshot: row.phoneSnapshot,
		roomLabel: row.activeTenancy?.roomLabel ?? null,
		activeTenancyId: row.activeTenancy?.tenancyId ?? null
	};
}

export function toTenantSelfDto(input: {
	user: { id: string; name: string; email: string | null; phone: string | null };
	managedTenants: Array<{
		id: string;
		displayName: string;
		landlordId: string;
		activeTenancies: ActiveTenancySummaryDto[];
	}>;
}): TenantSelfDto {
	return {
		identity: {
			id: input.user.id,
			name: input.user.name,
			email: input.user.email,
			phone: input.user.phone
		},
		managedTenants: input.managedTenants.map((row) => ({
			id: row.id,
			tenantId: row.id,
			displayName: row.displayName,
			landlordId: row.landlordId,
			activeTenancies: row.activeTenancies
		}))
	};
}

export function toManagedTenantDetailForLandlordDto(
	summary: TenantSummaryForLandlordDto,
	legacyTenantProfileId: string | null
): ManagedTenantDetailForLandlordDto {
	return { ...summary, legacyTenantProfileId };
}

export function toManagedTenantDetailForStaffDto(
	summary: TenantSummaryForStaffDto
): ManagedTenantDetailForStaffDto {
	return summary;
}

export function toManagedTenantDetailForTenantDto(row: {
	id: string;
	displayName: string;
	landlordId: string;
	activeTenancies: ActiveTenancySummaryDto[];
	profile: ManagedTenantDetailForTenantDto['profile'];
}): ManagedTenantDetailForTenantDto {
	return {
		id: row.id,
		tenantId: row.id,
		displayName: row.displayName,
		landlordId: row.landlordId,
		activeTenancies: row.activeTenancies,
		profile: row.profile
	};
}
