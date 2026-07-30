function toIso(value: Date | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value instanceof Date ? value.toISOString() : value;
}

export type SubscriptionChangeRequestDto = {
	id: string;
	requestedTier: string;
	requestedPeriod: string;
	currentTier: string;
	currentPeriod: string;
	requestedRentalTypes: string | null;
	requestedRoomAdditions: string | null;
	standardRoomCount: number;
	colivingRoomCount: number;
	quotedMonthlyPrice: number | null;
	quotedPeriodPrice: number | null;
	pricingStrategy: string;
	status: string;
	note: string | null;
	adminNote: string | null;
	createdAt: string;
	reviewedAt: string | null;
};

export type SubscriptionChangeRequestRowForDto = {
	id: string;
	requestedTier: string;
	requestedPeriod: string;
	currentTier: string;
	currentPeriod: string;
	requestedRentalTypes: string | null;
	requestedRoomAdditions: string | null;
	standardRoomCount: number;
	colivingRoomCount: number;
	quotedMonthlyPrice: number | null;
	quotedPeriodPrice: number | null;
	pricingStrategy: string;
	status: string;
	note: string | null;
	adminNote: string | null;
	createdAt: Date | string;
	reviewedAt: Date | string | null;
};

export function toSubscriptionChangeRequestDto(
	row: SubscriptionChangeRequestRowForDto
): SubscriptionChangeRequestDto {
	return {
		id: row.id,
		requestedTier: row.requestedTier,
		requestedPeriod: row.requestedPeriod,
		currentTier: row.currentTier,
		currentPeriod: row.currentPeriod,
		requestedRentalTypes: row.requestedRentalTypes,
		requestedRoomAdditions: row.requestedRoomAdditions,
		standardRoomCount: row.standardRoomCount,
		colivingRoomCount: row.colivingRoomCount,
		quotedMonthlyPrice: row.quotedMonthlyPrice ?? 0,
		quotedPeriodPrice: row.quotedPeriodPrice ?? 0,
		pricingStrategy: row.pricingStrategy,
		status: row.status,
		note: row.note,
		adminNote: row.adminNote,
		createdAt: toIso(row.createdAt) ?? '',
		reviewedAt: toIso(row.reviewedAt)
	};
}

export function toSubscriptionChangeRequestListDto(
	rows: SubscriptionChangeRequestRowForDto[]
): SubscriptionChangeRequestDto[] {
	return rows.map(toSubscriptionChangeRequestDto);
}
