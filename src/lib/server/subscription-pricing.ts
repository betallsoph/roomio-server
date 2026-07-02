export type SubscriptionTier =
	| 'FREE'
	| 'ROOMS_4_10'
	| 'ROOMS_11_25'
	| 'ROOMS_26_50'
	| 'ROOMS_51_100'
	| 'ROOMS_101_PLUS';
export type SubscriptionPeriod = 'MONTHLY' | 'YEARLY';
export type PricingGroup = 'STANDARD' | 'COLIVING';

export const SUBSCRIPTION_TIERS: SubscriptionTier[] = [
	'FREE',
	'ROOMS_4_10',
	'ROOMS_11_25',
	'ROOMS_26_50',
	'ROOMS_51_100',
	'ROOMS_101_PLUS'
];
export const SUBSCRIPTION_PERIODS: SubscriptionPeriod[] = ['MONTHLY', 'YEARLY'];

const TIER_LIMITS: Record<SubscriptionTier, { minRooms: number; maxRooms: number | null }> = {
	FREE: { minRooms: 0, maxRooms: 3 },
	ROOMS_4_10: { minRooms: 4, maxRooms: 10 },
	ROOMS_11_25: { minRooms: 11, maxRooms: 25 },
	ROOMS_26_50: { minRooms: 26, maxRooms: 50 },
	ROOMS_51_100: { minRooms: 51, maxRooms: 100 },
	ROOMS_101_PLUS: { minRooms: 101, maxRooms: null }
};

const MONTHLY_PRICES: Record<PricingGroup, Record<SubscriptionTier, number | null>> = {
	STANDARD: {
		FREE: 0,
		ROOMS_4_10: 149_000,
		ROOMS_11_25: 349_000,
		ROOMS_26_50: 699_000,
		ROOMS_51_100: 1_399_000,
		ROOMS_101_PLUS: null
	},
	COLIVING: {
		FREE: 0,
		ROOMS_4_10: 129_000,
		ROOMS_11_25: 319_000,
		ROOMS_26_50: 629_000,
		ROOMS_51_100: 1_199_000,
		ROOMS_101_PLUS: null
	}
};

const STANDARD_RENTAL_TYPES = new Set(['APARTMENT', 'MOTEL', 'SERVICED_APARTMENT', 'DORM']);

export type SubscriptionQuote = {
	tier: SubscriptionTier;
	period: SubscriptionPeriod;
	minRooms: number;
	maxRooms: number | null;
	pricingGroups: PricingGroup[];
	monthlyPrice: number | null;
	periodPrice: number | null;
	roomCount: number;
	overCapacity: boolean;
	requiresContact: boolean;
	breakdown: { group: PricingGroup; monthlyPrice: number | null }[];
};

export function pricingGroupsForRentalTypes(rentalTypes: string[]): PricingGroup[] {
	const normalized = new Set(rentalTypes.map((type) => type.trim().toUpperCase()));
	const groups: PricingGroup[] = [];
	if ([...normalized].some((type) => STANDARD_RENTAL_TYPES.has(type))) groups.push('STANDARD');
	if (normalized.has('COLIVING')) groups.push('COLIVING');
	return groups.length > 0 ? groups : ['STANDARD'];
}

export function calculateSubscriptionQuote(input: {
	tier: SubscriptionTier;
	period: SubscriptionPeriod;
	rentalTypes: string[];
	roomCount?: number;
}): SubscriptionQuote {
	const { tier, period } = input;
	const roomCount = Math.max(
		0,
		Math.floor(Number.isFinite(input.roomCount) ? input.roomCount! : 0)
	);
	const pricingGroups = pricingGroupsForRentalTypes(input.rentalTypes);
	const breakdown = pricingGroups.map((group) => ({
		group,
		monthlyPrice: MONTHLY_PRICES[group][tier]
	}));
	const requiresContact = breakdown.some((item) => item.monthlyPrice === null);
	const monthlyPrice = requiresContact
		? null
		: breakdown.reduce((sum, item) => sum + (item.monthlyPrice ?? 0), 0);
	const limits = TIER_LIMITS[tier];

	return {
		tier,
		period,
		minRooms: limits.minRooms,
		maxRooms: limits.maxRooms,
		pricingGroups,
		monthlyPrice,
		periodPrice: monthlyPrice === null ? null : monthlyPrice * (period === 'YEARLY' ? 12 : 1),
		roomCount,
		overCapacity: limits.maxRooms !== null && roomCount > limits.maxRooms,
		requiresContact,
		breakdown
	};
}

export function subscriptionExpiryDate(period: SubscriptionPeriod, from = new Date()): Date {
	const expiresAt = new Date(from);
	const originalDay = expiresAt.getDate();
	expiresAt.setDate(1);
	if (period === 'YEARLY') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
	else expiresAt.setMonth(expiresAt.getMonth() + 1);
	const lastDayOfTargetMonth = new Date(
		expiresAt.getFullYear(),
		expiresAt.getMonth() + 1,
		0
	).getDate();
	expiresAt.setDate(Math.min(originalDay, lastDayOfTargetMonth));
	return expiresAt;
}
