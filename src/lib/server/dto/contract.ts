import {
	toPaymentAccountDto,
	type PaymentAccountDto,
	type PaymentAccountRowForDto
} from './payment-account.js';

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

export type ContractTenantUserDto = {
	name: string;
	phone: string;
};

export type ContractTenantDto = {
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
	user: ContractTenantUserDto;
};

export type ContractPropertySummaryDto = {
	name: string;
	shortName: string;
};

export type ContractRoomDto = {
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
	property: ContractPropertySummaryDto;
	paymentAccount?: PaymentAccountDto | null;
};

export type ContractDto = {
	id: string;
	tenantId: string;
	roomId: string;
	tenancyId: string | null;
	managedTenantId: string | null;
	startDate: string;
	endDate: string;
	monthlyRent: number;
	deposit: number;
	fileUrl: string | null;
	notes: string | null;
	status: string;
	paymentAccountId: string | null;
	createdAt: string;
	tenant?: ContractTenantDto;
	room?: ContractRoomDto;
	paymentAccount?: PaymentAccountDto | null;
};

type ContractRowForDto = {
	id: string;
	tenantId: string;
	roomId: string;
	tenancyId?: string | null;
	managedTenantId?: string | null;
	startDate: string;
	endDate: string;
	monthlyRent: number;
	deposit: number;
	fileUrl: string | null;
	notes: string | null;
	status: string;
	paymentAccountId: string | null;
	createdAt: Date | string;
	tenant?: {
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
		user: ContractTenantUserDto;
	} | null;
	room?: {
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
		property: ContractPropertySummaryDto;
		paymentAccount?: PaymentAccountRowForDto | null;
	} | null;
	paymentAccount?: PaymentAccountRowForDto | null;
};

export function toContractDto(row: ContractRowForDto): ContractDto {
	const dto: ContractDto = {
		id: row.id,
		tenantId: row.tenantId,
		roomId: row.roomId,
		tenancyId: row.tenancyId ?? null,
		managedTenantId: row.managedTenantId ?? null,
		startDate: row.startDate,
		endDate: row.endDate,
		monthlyRent: row.monthlyRent,
		deposit: row.deposit,
		fileUrl: row.fileUrl,
		notes: row.notes,
		status: row.status,
		paymentAccountId: row.paymentAccountId,
		createdAt: toIso(row.createdAt)
	};

	if (row.tenant) {
		dto.tenant = {
			id: row.tenant.id,
			userId: row.tenant.userId,
			telegramUserId: row.tenant.telegramUserId,
			idNumber: row.tenant.idNumber,
			idFrontImage: row.tenant.idFrontImage,
			idBackImage: row.tenant.idBackImage,
			vehicleImage: row.tenant.vehicleImage,
			checkInImage: row.tenant.checkInImage,
			moveInDate: row.tenant.moveInDate,
			deposit: row.tenant.deposit,
			notes: row.tenant.notes,
			user: {
				name: row.tenant.user.name,
				phone: row.tenant.user.phone
			}
		};
	}

	if (row.room) {
		dto.room = {
			id: row.room.id,
			propertyId: row.room.propertyId,
			blockId: row.room.blockId,
			roomNumber: row.room.roomNumber,
			roomCode: row.room.roomCode,
			roomType: row.room.roomType,
			floor: row.room.floor,
			status: row.room.status,
			monthlyRent: row.room.monthlyRent,
			area: row.room.area,
			debtAmount: row.room.debtAmount,
			paymentAccountId: row.room.paymentAccountId,
			tenantId: row.room.tenantId,
			currentManagedTenantId: row.room.currentManagedTenantId,
			property: {
				name: row.room.property.name,
				shortName: row.room.property.shortName
			},
			...(row.room.paymentAccount !== undefined
				? {
						paymentAccount: row.room.paymentAccount
							? toPaymentAccountDto(row.room.paymentAccount)
							: null
					}
				: {})
		};
	}

	if (row.paymentAccount !== undefined) {
		dto.paymentAccount = row.paymentAccount ? toPaymentAccountDto(row.paymentAccount) : null;
	}

	return dto;
}
