import {
	toPaymentAccountDto,
	type PaymentAccountDto,
	type PaymentAccountRowForDto
} from './payment-account.js';

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

export type InvoiceItemDto = {
	id: string;
	invoiceId: string;
	name: string;
	amount: number;
	details: string | null;
};

export type PropertySummaryDto = {
	id: string;
	landlordId: string;
	name: string;
	shortName: string;
	address: string;
	rentalType: string;
	operatingModel: string;
	createdAt: string;
};

export type BlockSummaryDto = {
	id: string;
	propertyId: string;
	name: string;
};

export type LandlordSummaryDto = {
	id: string;
};

export type InvoiceRoomDto = {
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
	property: PropertySummaryDto & { landlord?: LandlordSummaryDto };
	block: BlockSummaryDto | null;
};

export type InvoiceDto = {
	id: string;
	roomId: string;
	roomNumber: string;
	tenantName: string;
	tenantPhone: string;
	month: string;
	rentAmount: number;
	totalAmount: number;
	dueDate: string;
	paidDate: string | null;
	status: string;
	paidAmount: number;
	paymentProofImage: string | null;
	paymentMethod: string | null;
	paymentProvider: string | null;
	paymentAccountId: string | null;
	payosOrderCode: string | null;
	payosPaymentLinkId: string | null;
	payosCheckoutUrl: string | null;
	payosQrCode: string | null;
	payosStatus: string | null;
	createdAt: string;
	notes: string | null;
	managedTenantId: string | null;
	tenancyId: string | null;
	items?: InvoiceItemDto[];
	paymentAccount?: PaymentAccountDto | null;
	room?: InvoiceRoomDto;
};

type InvoiceItemRow = {
	id: string;
	invoiceId: string;
	name: string;
	amount: number;
	details: string | null;
};

type InvoiceRowForDto = {
	id: string;
	roomId: string;
	roomNumber: string;
	tenantName: string;
	tenantPhone: string;
	month: string;
	rentAmount: number;
	totalAmount: number;
	dueDate: string;
	paidDate: string | null;
	status: string;
	paidAmount: number;
	paymentProofImage: string | null;
	paymentMethod: string | null;
	paymentProvider: string | null;
	paymentAccountId: string | null;
	payosOrderCode: string | null;
	payosPaymentLinkId: string | null;
	payosCheckoutUrl: string | null;
	payosQrCode: string | null;
	payosStatus: string | null;
	createdAt: string;
	notes: string | null;
	managedTenantId: string | null;
	tenancyId: string | null;
	items?: InvoiceItemRow[] | null;
	paymentAccount?: PaymentAccountRowForDto | null;
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
		/** Present on detail reads; mutation `.returning()` / shallow loads may omit it. */
		property?: {
			id: string;
			landlordId: string;
			name: string;
			shortName: string;
			address: string;
			rentalType: string;
			operatingModel: string;
			createdAt: Date | string;
			landlord?: { id: string } | null;
		};
		block?: BlockSummaryDto | null;
	} | null;
};

export function toInvoiceItemDto(row: InvoiceItemRow): InvoiceItemDto {
	return {
		id: row.id,
		invoiceId: row.invoiceId,
		name: row.name,
		amount: row.amount,
		details: row.details
	};
}

type PropertyRowForDto = {
	id: string;
	landlordId: string;
	name: string;
	shortName: string;
	address: string;
	rentalType: string;
	operatingModel: string;
	createdAt: Date | string;
	landlord?: { id: string } | null;
};

function toPropertySummaryDto(
	row: PropertyRowForDto
): PropertySummaryDto & { landlord?: LandlordSummaryDto } {
	return {
		id: row.id,
		landlordId: row.landlordId,
		name: row.name,
		shortName: row.shortName,
		address: row.address,
		rentalType: row.rentalType,
		operatingModel: row.operatingModel,
		createdAt: toIso(row.createdAt),
		...(row.landlord ? { landlord: { id: row.landlord.id } } : {})
	};
}

function toInvoiceRoomDto(room: NonNullable<InvoiceRowForDto['room']>): InvoiceRoomDto | null {
	if (!room.property) {
		return null;
	}
	return {
		id: room.id,
		propertyId: room.propertyId,
		blockId: room.blockId,
		roomNumber: room.roomNumber,
		roomCode: room.roomCode,
		roomType: room.roomType,
		floor: room.floor,
		status: room.status,
		monthlyRent: room.monthlyRent,
		area: room.area,
		debtAmount: room.debtAmount,
		paymentAccountId: room.paymentAccountId,
		tenantId: room.tenantId,
		currentManagedTenantId: room.currentManagedTenantId,
		property: toPropertySummaryDto(room.property),
		block: room.block
			? {
					id: room.block.id,
					propertyId: room.block.propertyId,
					name: room.block.name
				}
			: null
	};
}

export function toInvoiceDto(row: InvoiceRowForDto): InvoiceDto {
	const dto: InvoiceDto = {
		id: row.id,
		roomId: row.roomId,
		roomNumber: row.roomNumber,
		tenantName: row.tenantName,
		tenantPhone: row.tenantPhone,
		month: row.month,
		rentAmount: row.rentAmount,
		totalAmount: row.totalAmount,
		dueDate: row.dueDate,
		paidDate: row.paidDate,
		status: row.status,
		paidAmount: row.paidAmount,
		paymentProofImage: row.paymentProofImage,
		paymentMethod: row.paymentMethod,
		paymentProvider: row.paymentProvider,
		paymentAccountId: row.paymentAccountId,
		payosOrderCode: row.payosOrderCode,
		payosPaymentLinkId: row.payosPaymentLinkId,
		payosCheckoutUrl: row.payosCheckoutUrl,
		payosQrCode: row.payosQrCode,
		payosStatus: row.payosStatus,
		createdAt: row.createdAt,
		notes: row.notes,
		managedTenantId: row.managedTenantId,
		tenancyId: row.tenancyId
	};

	if (row.items) {
		dto.items = row.items.map(toInvoiceItemDto);
	}
	if (row.paymentAccount !== undefined) {
		dto.paymentAccount = row.paymentAccount ? toPaymentAccountDto(row.paymentAccount) : null;
	}
	if (row.room) {
		const roomDto = toInvoiceRoomDto(row.room);
		if (roomDto) {
			dto.room = roomDto;
		}
	}

	return dto;
}

export type BulkInvoicePrepTenantUserDto = {
	name: string;
	phone: string | null;
};

export type BulkInvoicePrepTenantDto = {
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
	user: BulkInvoicePrepTenantUserDto;
};

export type BulkInvoicePrepServiceDto = {
	id: string;
	landlordId: string;
	name: string;
	type: string;
	defaultRate: number;
	isActive: boolean;
};

export type BulkInvoicePrepRoomServiceDto = {
	id: string;
	roomId: string;
	serviceId: string;
	customRate: number | null;
	quantity: number;
	service: BulkInvoicePrepServiceDto;
};

export type BulkInvoicePrepRoomDto = {
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
	tenant: BulkInvoicePrepTenantDto | null;
	services: BulkInvoicePrepRoomServiceDto[];
	paymentAccount: PaymentAccountDto | null;
};

type BulkInvoicePrepRoomRow = {
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
		user: BulkInvoicePrepTenantUserDto;
	} | null;
	services?: Array<{
		id: string;
		roomId: string;
		serviceId: string;
		customRate: number | null;
		quantity: number;
		service: BulkInvoicePrepServiceDto;
	}>;
	paymentAccount?: PaymentAccountRowForDto | null;
};

export function toBulkInvoicePrepRoomDto(row: BulkInvoicePrepRoomRow): BulkInvoicePrepRoomDto {
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
		tenant: row.tenant
			? {
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
				}
			: null,
		services: (row.services ?? []).map((config) => ({
			id: config.id,
			roomId: config.roomId,
			serviceId: config.serviceId,
			customRate: config.customRate,
			quantity: config.quantity,
			service: {
				id: config.service.id,
				landlordId: config.service.landlordId,
				name: config.service.name,
				type: config.service.type,
				defaultRate: config.service.defaultRate,
				isActive: config.service.isActive
			}
		})),
		paymentAccount: row.paymentAccount ? toPaymentAccountDto(row.paymentAccount) : null
	};
}
