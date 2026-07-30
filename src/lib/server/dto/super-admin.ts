import type { SuperAdminLandlordPlatformRow } from '$lib/server/aggregate-scope/super-admin-platform';

function toIso(value: Date | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value instanceof Date ? value.toISOString() : value;
}

export type SuperAdminUserDto = {
	id: string;
	name: string;
	email: string;
	phone: string;
	isActive: boolean;
	createdAt: string;
};

export type SuperAdminPropertyDto = {
	id: string;
	name: string;
	rentalType: string;
	operatingModel: string;
	_count: { rooms: number };
};

export type SuperAdminLandlordDto = {
	id: string;
	userId: string;
	subscriptionType: string;
	subscriptionPeriod: string;
	subValidUntil: string | null;
	subscribedStandardRoomLimit: number | null;
	subscribedColivingRoomLimit: number | null;
	companyName: string | null;
	enabledRentalTypes: string;
	user: SuperAdminUserDto;
	properties: SuperAdminPropertyDto[];
	subscriptionQuote: SuperAdminLandlordPlatformRow['subscriptionQuote'];
	metrics: SuperAdminLandlordPlatformRow['metrics'];
};

/** Forbidden operational keys that must never appear in super-admin responses. */
export const SUPER_ADMIN_FORBIDDEN_KEYS = [
	'tenantId',
	'debtAmount',
	'invoices',
	'rooms',
	'paymentAccount',
	'passwordHash',
	'payosApiKeyEnc',
	'payosChecksumKeyEnc'
] as const;

export function toSuperAdminLandlordDto(row: SuperAdminLandlordPlatformRow): SuperAdminLandlordDto {
	return {
		id: row.id,
		userId: row.userId,
		subscriptionType: row.subscriptionType,
		subscriptionPeriod: row.subscriptionPeriod,
		subValidUntil: toIso(row.subValidUntil),
		subscribedStandardRoomLimit: row.subscribedStandardRoomLimit,
		subscribedColivingRoomLimit: row.subscribedColivingRoomLimit,
		companyName: row.companyName,
		enabledRentalTypes: row.enabledRentalTypes,
		user: {
			id: row.user.id,
			name: row.user.name,
			email: row.user.email,
			phone: row.user.phone,
			isActive: row.user.isActive,
			createdAt: toIso(row.user.createdAt) ?? ''
		},
		properties: row.properties.map((property) => ({
			id: property.id,
			name: property.name,
			rentalType: property.rentalType,
			operatingModel: property.operatingModel,
			_count: { rooms: property.roomCount }
		})),
		subscriptionQuote: row.subscriptionQuote,
		metrics: row.metrics
	};
}

export function toSuperAdminLandlordListDto(
	rows: SuperAdminLandlordPlatformRow[]
): SuperAdminLandlordDto[] {
	return rows.map(toSuperAdminLandlordDto);
}
