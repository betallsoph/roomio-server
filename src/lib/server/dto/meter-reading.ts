/** §9 DTO allowlists for meter reading API responses. */

export const METER_READING_RESPONSE_COLUMNS = {
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

export type MeterReadingListItemDto = MeterReadingDto & {
	roomNumber: string;
	propertyName: string;
	serviceName: string | null;
};

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

export function toMeterReadingListItemDto(row: {
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
	roomNumber: string;
	propertyName: string;
	serviceName: string | null;
	ocrRawText?: string | null;
}): MeterReadingListItemDto {
	return {
		...toMeterReadingDto(row),
		roomNumber: row.roomNumber,
		propertyName: row.propertyName,
		serviceName: row.serviceName
	};
}
