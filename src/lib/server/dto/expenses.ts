function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

export type ExpensePropertySummaryDto = {
	name: string;
	shortName: string;
};

export type ExpenseDto = {
	id: string;
	category: string;
	description: string;
	amount: number;
	date: string;
	notes: string | null;
	propertyId: string | null;
	property: ExpensePropertySummaryDto | null;
	createdAt: string;
};

export type ExpenseRowForDto = {
	id: string;
	category: string;
	description: string;
	amount: number;
	date: string;
	notes: string | null;
	propertyId: string | null;
	createdAt: Date | string;
	property?: { name: string; shortName: string } | null;
};

export function toExpenseDto(row: ExpenseRowForDto): ExpenseDto {
	return {
		id: row.id,
		category: row.category,
		description: row.description,
		amount: row.amount,
		date: row.date,
		notes: row.notes,
		propertyId: row.propertyId,
		property: row.property ? { name: row.property.name, shortName: row.property.shortName } : null,
		createdAt: toIso(row.createdAt)
	};
}

export function toExpenseListDto(rows: ExpenseRowForDto[]): ExpenseDto[] {
	return rows.map(toExpenseDto);
}
