export const RENTAL_TYPES = ['APARTMENT', 'MOTEL', 'DORM', 'WHOLE_UNIT'] as const;
export type RentalType = (typeof RENTAL_TYPES)[number];

/** Trim, uppercase, map legacy aliases. Does not validate against RENTAL_TYPES. */
export function canonicalRentalType(value: unknown): string {
	const type = String(value).trim().toUpperCase();
	if (type === 'COLIVING') return 'APARTMENT';
	if (type === 'SERVICED_APARTMENT') return 'MOTEL';
	return type;
}

export function isValidRentalType(value: string): value is RentalType {
	return (RENTAL_TYPES as readonly string[]).includes(value);
}

/** Canonicalize, validate, fallback (properties endpoint behavior). */
export function normalizeRentalTypeOr(
	value: unknown,
	fallback: RentalType = 'APARTMENT'
): RentalType {
	const normalized = typeof value === 'string' ? value.trim().toUpperCase() : fallback;
	const canonical = canonicalRentalType(normalized);
	return isValidRentalType(canonical) ? canonical : fallback;
}

/** Split comma list, canonicalize, dedupe, filter valid; default ['APARTMENT'] when empty. */
export function parseEnabledRentalTypes(value: string | null | undefined): RentalType[] {
	const raw = (value ?? 'APARTMENT').split(',').map((type) => canonicalRentalType(type)).filter(Boolean);
	const unique = [...new Set(raw)].filter(isValidRentalType);
	return unique.length > 0 ? unique : ['APARTMENT'];
}

export const OPERATING_MODELS = ['UNSPECIFIED', 'OWNED', 'RENT_TO_RENT', 'MANAGED'] as const;
export type OperatingModel = (typeof OPERATING_MODELS)[number];

export function isValidOperatingModel(value: string): value is OperatingModel {
	return (OPERATING_MODELS as readonly string[]).includes(value);
}
