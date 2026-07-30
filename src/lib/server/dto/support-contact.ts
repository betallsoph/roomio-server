function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

export type SupportContactLandlordDto = {
	id: string;
	category: string;
	name: string;
	phone: string;
	secondaryPhone: string | null;
	company: string | null;
	serviceArea: string | null;
	notes: string | null;
	isPinned: boolean;
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
};

/** Tenant-visible shareable fields only — no landlordId or internal notes. */
export type SupportContactTenantDto = {
	id: string;
	category: string;
	name: string;
	phone: string;
	secondaryPhone: string | null;
	company: string | null;
	serviceArea: string | null;
	isPinned: boolean;
};

export type SupportContactRowForDto = {
	id: string;
	category: string;
	name: string;
	phone: string;
	secondaryPhone: string | null;
	company: string | null;
	serviceArea: string | null;
	notes: string | null;
	isPinned: boolean;
	isActive: boolean;
	createdAt: Date | string;
	updatedAt: Date | string;
};

export function toSupportContactLandlordDto(
	row: SupportContactRowForDto
): SupportContactLandlordDto {
	return {
		id: row.id,
		category: row.category,
		name: row.name,
		phone: row.phone,
		secondaryPhone: row.secondaryPhone,
		company: row.company,
		serviceArea: row.serviceArea,
		notes: row.notes,
		isPinned: row.isPinned,
		isActive: row.isActive,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt)
	};
}

export function toSupportContactTenantDto(row: SupportContactRowForDto): SupportContactTenantDto {
	return {
		id: row.id,
		category: row.category,
		name: row.name,
		phone: row.phone,
		secondaryPhone: row.secondaryPhone,
		company: row.company,
		serviceArea: row.serviceArea,
		isPinned: row.isPinned
	};
}

export function toSupportContactLandlordListDto(
	rows: SupportContactRowForDto[]
): SupportContactLandlordDto[] {
	return rows.map(toSupportContactLandlordDto);
}

export function toSupportContactTenantListDto(
	rows: SupportContactRowForDto[]
): SupportContactTenantDto[] {
	return rows.map(toSupportContactTenantDto);
}
