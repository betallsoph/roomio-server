import {
	BLOCK_COLUMNS,
	PAYMENT_ACCOUNT_COLUMNS,
	PROPERTY_SUMMARY_COLUMNS,
	PUBLIC_USER_COLUMNS,
	toPublicUserDto,
	toTenantProfileDto,
	toTenantRoomSummaryDto,
	type TenantProfileDto,
	type TenantRoomSummaryDto
} from './rooms.js';

export const TENANT_ROOM_WITH = {
	columns: {
		id: true,
		propertyId: true,
		blockId: true,
		roomNumber: true,
		roomCode: true,
		roomType: true,
		floor: true,
		status: true,
		monthlyRent: true,
		area: true,
		debtAmount: true,
		paymentAccountId: true,
		tenantId: true,
		currentManagedTenantId: true
	},
	with: {
		property: { columns: PROPERTY_SUMMARY_COLUMNS },
		block: { columns: BLOCK_COLUMNS },
		paymentAccount: { columns: PAYMENT_ACCOUNT_COLUMNS }
	}
} as const;

/** Relational `with` for tenant list/detail queries. */
export const TENANT_DETAIL_WITH = {
	user: { columns: PUBLIC_USER_COLUMNS },
	rooms: TENANT_ROOM_WITH
} as const;

export type TenantSummaryDto = TenantProfileDto & {
	user: NonNullable<TenantProfileDto['user']>;
	rooms: TenantRoomSummaryDto[];
};

export function toTenantSummaryDto(row: {
	id: string;
	userId: string;
	telegramUserId: string | null;
	idNumber: string | null;
	idFrontImage: string | null;
	idBackImage: string | null;
	vehicleImage: string | null;
	checkInImage: string | null;
	moveInDate: string | null;
	deposit: number | null;
	notes: string | null;
	user: {
		id: string;
		name: string;
		email: string;
		phone: string;
		isActive: boolean;
	};
	rooms?: Array<{
		id: string;
		propertyId: string;
		blockId: string | null;
		roomNumber: string;
		roomCode: string | null;
		roomType: string;
		floor: number | null;
		status: string;
		monthlyRent: number;
		area: number | null;
		debtAmount: number | null;
		paymentAccountId: string | null;
		tenantId: string | null;
		currentManagedTenantId: string | null;
		property?: {
			id: string;
			landlordId: string;
			name: string;
			shortName: string;
			address: string;
			rentalType: string;
			operatingModel: string;
			createdAt: Date;
		} | null;
		block?: { id: string; propertyId: string; name: string } | null;
		paymentAccount?: {
			id: string;
			name: string;
			provider: string;
			isDefault: boolean;
			isActive: boolean;
			bankName: string;
			bankCode: string;
			accountNumber: string;
			accountName: string;
			bankBranch: string | null;
			momoNumber: string | null;
			payosClientId: string | null;
			payosConnectedAt: Date | null;
			createdAt: Date;
			updatedAt: Date;
		} | null;
	}>;
}): TenantSummaryDto {
	const profile = toTenantProfileDto(row);
	const user = toPublicUserDto(row.user);
	if (!profile || !user) {
		throw new Error('Tenant summary requires profile and user');
	}
	return {
		...profile,
		user,
		rooms: (row.rooms ?? []).map(toTenantRoomSummaryDto)
	};
}
