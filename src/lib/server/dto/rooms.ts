/** §9 DTO allowlists for room API responses — never spread raw DB rows or nested relations. */

export const PUBLIC_USER_COLUMNS = {
	id: true,
	name: true,
	email: true,
	phone: true,
	isActive: true
} as const;

export const PAYMENT_ACCOUNT_COLUMNS = {
	id: true,
	name: true,
	provider: true,
	isDefault: true,
	isActive: true,
	bankName: true,
	bankCode: true,
	accountNumber: true,
	accountName: true,
	bankBranch: true,
	momoNumber: true,
	payosClientId: true,
	payosConnectedAt: true,
	createdAt: true,
	updatedAt: true
} as const;

export const PROPERTY_SUMMARY_COLUMNS = {
	id: true,
	landlordId: true,
	name: true,
	shortName: true,
	address: true,
	rentalType: true,
	operatingModel: true,
	createdAt: true
} as const;

export const BLOCK_COLUMNS = {
	id: true,
	propertyId: true,
	name: true
} as const;

export const TENANT_PROFILE_COLUMNS = {
	id: true,
	userId: true,
	telegramUserId: true,
	idNumber: true,
	idFrontImage: true,
	idBackImage: true,
	vehicleImage: true,
	checkInImage: true,
	moveInDate: true,
	deposit: true,
	notes: true
} as const;

export const SERVICE_COLUMNS = {
	id: true,
	landlordId: true,
	name: true,
	type: true,
	defaultRate: true,
	isActive: true
} as const;

export const ROOM_SERVICE_CONFIG_COLUMNS = {
	id: true,
	roomId: true,
	serviceId: true,
	customRate: true,
	quantity: true
} as const;

export const ROOM_ASSET_COLUMNS = {
	id: true,
	roomId: true,
	name: true,
	code: true,
	status: true,
	imageUrl: true,
	notes: true
} as const;

export const METER_READING_COLUMNS = {
	id: true,
	roomId: true,
	serviceId: true,
	month: true,
	prevValue: true,
	submittedValue: true,
	currValue: true,
	recordedAt: true,
	photoUrl: true,
	ocrParsedValue: true,
	status: true,
	submittedBy: true,
	isAnomalous: true,
	managedTenantId: true,
	tenancyId: true
} as const;

export const ROOM_COLUMNS = {
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
} as const;

/** Relational `with` for full room detail queries (add meterReadings orderBy at call site). */
export const ROOM_DETAIL_WITH = {
	block: { columns: BLOCK_COLUMNS },
	property: { columns: PROPERTY_SUMMARY_COLUMNS },
	paymentAccount: { columns: PAYMENT_ACCOUNT_COLUMNS },
	tenant: {
		columns: TENANT_PROFILE_COLUMNS,
		with: { user: { columns: PUBLIC_USER_COLUMNS } }
	},
	services: {
		columns: ROOM_SERVICE_CONFIG_COLUMNS,
		with: { service: { columns: SERVICE_COLUMNS } }
	},
	assets: { columns: ROOM_ASSET_COLUMNS },
	meterReadings: { columns: METER_READING_COLUMNS }
} as const;

export type PublicUserDto = {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	isActive: boolean;
};

export type PaymentAccountDto = {
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
};

export type PropertySummaryDto = {
	id: string;
	landlordId: string;
	name: string;
	shortName: string;
	address: string;
	rentalType: string;
	operatingModel: string;
	createdAt: Date;
};

export type BlockDto = {
	id: string;
	propertyId: string;
	name: string;
};

export type TenantProfileDto = {
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
	user: PublicUserDto | null;
};

export type ServiceDto = {
	id: string;
	landlordId: string;
	name: string;
	type: string;
	defaultRate: number;
	isActive: boolean;
};

export type RoomServiceConfigDto = {
	id: string;
	roomId: string;
	serviceId: string;
	customRate: number | null;
	quantity: number;
	service: ServiceDto | null;
};

export type RoomAssetDto = {
	id: string;
	roomId: string;
	name: string;
	code: string | null;
	status: string;
	imageUrl: string | null;
	notes: string | null;
};

export type MeterReadingDto = {
	id: string;
	roomId: string;
	serviceId: string;
	month: string;
	prevValue: number;
	submittedValue: number | null;
	currValue: number;
	recordedAt: string;
	photoUrl: string | null;
	ocrParsedValue: number | null;
	status: string;
	submittedBy: string;
	isAnomalous: boolean;
	managedTenantId: string | null;
	tenancyId: string | null;
};

export type RoomDto = {
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
	block: BlockDto | null;
	property: PropertySummaryDto | null;
	paymentAccount: PaymentAccountDto | null;
	tenant: TenantProfileDto | null;
	services: RoomServiceConfigDto[];
	assets: RoomAssetDto[];
	meterReadings: MeterReadingDto[];
};

export type TenantRoomSummaryDto = {
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
	property: PropertySummaryDto | null;
	block: BlockDto | null;
	paymentAccount: PaymentAccountDto | null;
};

export function toPublicUserDto(
	row:
		| {
				id: string;
				name: string;
				email: string | null;
				phone: string | null;
				isActive: boolean;
		  }
		| null
		| undefined
): PublicUserDto | null {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		phone: row.phone,
		isActive: row.isActive
	};
}

export function toPaymentAccountDto(
	row:
		| {
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
		  }
		| null
		| undefined
): PaymentAccountDto | null {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		provider: row.provider,
		isDefault: row.isDefault,
		isActive: row.isActive,
		bankName: row.bankName,
		bankCode: row.bankCode,
		accountNumber: row.accountNumber,
		accountName: row.accountName,
		bankBranch: row.bankBranch,
		momoNumber: row.momoNumber,
		payosClientId: row.payosClientId,
		payosConnectedAt: row.payosConnectedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export function toPropertySummaryDto(
	row:
		| {
				id: string;
				landlordId: string;
				name: string;
				shortName: string;
				address: string;
				rentalType: string;
				operatingModel: string;
				createdAt: Date;
		  }
		| null
		| undefined
): PropertySummaryDto | null {
	if (!row) return null;
	return {
		id: row.id,
		landlordId: row.landlordId,
		name: row.name,
		shortName: row.shortName,
		address: row.address,
		rentalType: row.rentalType,
		operatingModel: row.operatingModel,
		createdAt: row.createdAt
	};
}

export function toBlockDto(
	row: { id: string; propertyId: string; name: string } | null | undefined
): BlockDto | null {
	if (!row) return null;
	return { id: row.id, propertyId: row.propertyId, name: row.name };
}

export function toTenantProfileDto(
	row:
		| {
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
				user?: {
					id: string;
					name: string;
					email: string | null;
					phone: string | null;
					isActive: boolean;
				} | null;
		  }
		| null
		| undefined
): TenantProfileDto | null {
	if (!row) return null;
	return {
		id: row.id,
		userId: row.userId,
		telegramUserId: row.telegramUserId,
		idNumber: row.idNumber,
		idFrontImage: row.idFrontImage,
		idBackImage: row.idBackImage,
		vehicleImage: row.vehicleImage,
		checkInImage: row.checkInImage,
		moveInDate: row.moveInDate,
		deposit: row.deposit,
		notes: row.notes,
		user: toPublicUserDto(row.user)
	};
}

export function toServiceDto(
	row:
		| {
				id: string;
				landlordId: string;
				name: string;
				type: string;
				defaultRate: number;
				isActive: boolean;
		  }
		| null
		| undefined
): ServiceDto | null {
	if (!row) return null;
	return {
		id: row.id,
		landlordId: row.landlordId,
		name: row.name,
		type: row.type,
		defaultRate: row.defaultRate,
		isActive: row.isActive
	};
}

export function toRoomServiceConfigDto(row: {
	id: string;
	roomId: string;
	serviceId: string;
	customRate: number | null;
	quantity: number;
	service?: {
		id: string;
		landlordId: string;
		name: string;
		type: string;
		defaultRate: number;
		isActive: boolean;
	} | null;
}): RoomServiceConfigDto {
	return {
		id: row.id,
		roomId: row.roomId,
		serviceId: row.serviceId,
		customRate: row.customRate,
		quantity: row.quantity,
		service: toServiceDto(row.service)
	};
}

export function toRoomAssetDto(row: {
	id: string;
	roomId: string;
	name: string;
	code: string | null;
	status: string;
	imageUrl: string | null;
	notes: string | null;
}): RoomAssetDto {
	return {
		id: row.id,
		roomId: row.roomId,
		name: row.name,
		code: row.code,
		status: row.status,
		imageUrl: row.imageUrl,
		notes: row.notes
	};
}

export function toMeterReadingDto(row: {
	id: string;
	roomId: string;
	serviceId: string;
	month: string;
	prevValue: number;
	submittedValue: number | null;
	currValue: number;
	recordedAt: string;
	photoUrl: string | null;
	ocrParsedValue: number | null;
	status: string;
	submittedBy: string;
	isAnomalous: boolean;
	managedTenantId: string | null;
	tenancyId: string | null;
	/** Accepted then discarded — never appears on MeterReadingDto. */
	ocrRawText?: string | null;
}): MeterReadingDto {
	return {
		id: row.id,
		roomId: row.roomId,
		serviceId: row.serviceId,
		month: row.month,
		prevValue: row.prevValue,
		submittedValue: row.submittedValue,
		currValue: row.currValue,
		recordedAt: row.recordedAt,
		photoUrl: row.photoUrl,
		ocrParsedValue: row.ocrParsedValue,
		status: row.status,
		submittedBy: row.submittedBy,
		isAnomalous: row.isAnomalous,
		managedTenantId: row.managedTenantId,
		tenancyId: row.tenancyId
	};
}

export function toRoomDto(row: {
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
	block?: { id: string; propertyId: string; name: string } | null;
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
	paymentAccount?: PaymentAccountDto | null;
	tenant?: TenantProfileDto | null;
	services?: Array<{
		id: string;
		roomId: string;
		serviceId: string;
		customRate: number | null;
		quantity: number;
		service?: {
			id: string;
			landlordId: string;
			name: string;
			type: string;
			defaultRate: number;
			isActive: boolean;
		} | null;
	}>;
	assets?: Array<{
		id: string;
		roomId: string;
		name: string;
		code: string | null;
		status: string;
		imageUrl: string | null;
		notes: string | null;
	}>;
	meterReadings?: Array<{
		id: string;
		roomId: string;
		serviceId: string;
		month: string;
		prevValue: number;
		submittedValue: number | null;
		currValue: number;
		recordedAt: string;
		photoUrl: string | null;
		ocrParsedValue: number | null;
		status: string;
		submittedBy: string;
		isAnomalous: boolean;
		managedTenantId: string | null;
		tenancyId: string | null;
		ocrRawText?: string | null;
	}>;
}): RoomDto {
	return {
		id: row.id,
		propertyId: row.propertyId,
		blockId: row.blockId,
		roomNumber: row.roomNumber,
		roomCode: row.roomCode,
		roomType: row.roomType,
		floor: row.floor,
		status: row.status,
		monthlyRent: row.monthlyRent,
		area: row.area,
		debtAmount: row.debtAmount,
		paymentAccountId: row.paymentAccountId,
		tenantId: row.tenantId,
		currentManagedTenantId: row.currentManagedTenantId,
		block: toBlockDto(row.block),
		property: toPropertySummaryDto(row.property),
		paymentAccount: toPaymentAccountDto(row.paymentAccount),
		tenant: toTenantProfileDto(row.tenant),
		services: (row.services ?? []).map(toRoomServiceConfigDto),
		assets: (row.assets ?? []).map(toRoomAssetDto),
		meterReadings: (row.meterReadings ?? []).map(toMeterReadingDto)
	};
}

export function toTenantRoomSummaryDto(row: {
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
	paymentAccount?: PaymentAccountDto | null;
}): TenantRoomSummaryDto {
	return {
		id: row.id,
		propertyId: row.propertyId,
		blockId: row.blockId,
		roomNumber: row.roomNumber,
		roomCode: row.roomCode,
		roomType: row.roomType,
		floor: row.floor,
		status: row.status,
		monthlyRent: row.monthlyRent,
		area: row.area,
		debtAmount: row.debtAmount,
		paymentAccountId: row.paymentAccountId,
		tenantId: row.tenantId,
		currentManagedTenantId: row.currentManagedTenantId,
		property: toPropertySummaryDto(row.property),
		block: toBlockDto(row.block),
		paymentAccount: toPaymentAccountDto(row.paymentAccount)
	};
}
