export type SubscriptionTier =
	| 'FREE'
	| 'ROOMS_4_10'
	| 'ROOMS_11_25'
	| 'ROOMS_26_50'
	| 'ROOMS_51_80'
	| 'ROOMS_81_100'
	| 'ROOMS_101_150'
	| 'ROOMS_151_PLUS';
export type SubscriptionPeriod = 'MONTHLY' | 'YEARLY';
export type PricingGroup = 'STANDARD' | 'COLIVING';
export type PricingStrategy = 'POOLED' | 'SPLIT';

export const SUBSCRIPTION_TIERS: SubscriptionTier[] = [
	'FREE',
	'ROOMS_4_10',
	'ROOMS_11_25',
	'ROOMS_26_50',
	'ROOMS_51_80',
	'ROOMS_81_100',
	'ROOMS_101_150',
	'ROOMS_151_PLUS'
];
export const SUBSCRIPTION_PERIODS: SubscriptionPeriod[] = ['MONTHLY', 'YEARLY'];

export function pricingGroupForRentalType(rentalType: string | null | undefined): PricingGroup {
	return rentalType === 'APARTMENT' || rentalType === 'COLIVING' ? 'COLIVING' : 'STANDARD';
}

const TIER_LIMITS: Record<SubscriptionTier, { minRooms: number; maxRooms: number | null }> = {
	FREE: { minRooms: 0, maxRooms: 3 },
	ROOMS_4_10: { minRooms: 4, maxRooms: 10 },
	ROOMS_11_25: { minRooms: 11, maxRooms: 25 },
	ROOMS_26_50: { minRooms: 26, maxRooms: 50 },
	ROOMS_51_80: { minRooms: 51, maxRooms: 80 },
	ROOMS_81_100: { minRooms: 81, maxRooms: 100 },
	ROOMS_101_150: { minRooms: 101, maxRooms: 150 },
	ROOMS_151_PLUS: { minRooms: 151, maxRooms: null }
};

export function subscriptionTierLimits(tier: SubscriptionTier) {
	return TIER_LIMITS[tier];
}

const MONTHLY_PRICES: Record<PricingGroup, Record<SubscriptionTier, number | null>> = {
	STANDARD: {
		FREE: 0,
		ROOMS_4_10: 149_000,
		ROOMS_11_25: 349_000,
		ROOMS_26_50: 699_000,
		ROOMS_51_80: 1_119_000,
		ROOMS_81_100: 1_399_000,
		ROOMS_101_150: 2_099_000,
		ROOMS_151_PLUS: null
	},
	COLIVING: {
		FREE: 0,
		ROOMS_4_10: 129_000,
		ROOMS_11_25: 319_000,
		ROOMS_26_50: 629_000,
		ROOMS_51_80: 959_000,
		ROOMS_81_100: 1_199_000,
		ROOMS_101_150: 1_799_000,
		ROOMS_151_PLUS: null
	}
};

export type PricingBreakdownItem = {
	group: PricingGroup;
	roomCount: number;
	tier: SubscriptionTier;
	monthlyPrice: number | null;
};

export type SubscriptionQuote = {
	tier: SubscriptionTier;
	recommendedTier: SubscriptionTier;
	period: SubscriptionPeriod;
	minRooms: number;
	maxRooms: number | null;
	strategy: PricingStrategy;
	splitEligible: boolean;
	monthlyPrice: number | null;
	periodPrice: number | null;
	pooledMonthlyPrice: number | null;
	splitMonthlyPrice: number | null;
	roomCount: number;
	standardRoomCount: number;
	colivingRoomCount: number;
	overCapacity: boolean;
	requiresContact: boolean;
	breakdown: PricingBreakdownItem[];
};

export function subscriptionTierForRoomCount(roomCount: number): SubscriptionTier {
	const normalized = normalizeRoomCount(roomCount);
	return (
		SUBSCRIPTION_TIERS.find((tier) => {
			const limits = TIER_LIMITS[tier];
			return (
				normalized >= limits.minRooms && (limits.maxRooms === null || normalized <= limits.maxRooms)
			);
		}) ?? 'ROOMS_151_PLUS'
	);
}

function normalizeRoomCount(value: number): number {
	return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function monthlyPrice(group: PricingGroup, tier: SubscriptionTier): number | null {
	return MONTHLY_PRICES[group][tier];
}

function sumPrices(items: PricingBreakdownItem[]): number | null {
	return items.some((item) => item.monthlyPrice === null)
		? null
		: items.reduce((sum, item) => sum + (item.monthlyPrice ?? 0), 0);
}

export function calculateSubscriptionQuote(input: {
	tier: SubscriptionTier;
	period: SubscriptionPeriod;
	standardRoomCount: number;
	colivingRoomCount: number;
}): SubscriptionQuote {
	const { tier, period } = input;
	const standardRoomCount = normalizeRoomCount(input.standardRoomCount);
	const colivingRoomCount = normalizeRoomCount(input.colivingRoomCount);
	const roomCount = standardRoomCount + colivingRoomCount;
	const recommendedTier = subscriptionTierForRoomCount(roomCount);
	const pooledGroup: PricingGroup =
		standardRoomCount > 0 ? 'STANDARD' : colivingRoomCount > 0 ? 'COLIVING' : 'STANDARD';
	const pooledBreakdown: PricingBreakdownItem[] = [
		{
			group: pooledGroup,
			roomCount,
			tier: recommendedTier,
			monthlyPrice: monthlyPrice(pooledGroup, recommendedTier)
		}
	];
	const splitBreakdown: PricingBreakdownItem[] = [];
	if (standardRoomCount > 0) {
		const standardTier = subscriptionTierForRoomCount(standardRoomCount);
		splitBreakdown.push({
			group: 'STANDARD',
			roomCount: standardRoomCount,
			tier: standardTier,
			monthlyPrice: monthlyPrice('STANDARD', standardTier)
		});
	}
	if (colivingRoomCount > 0) {
		const colivingTier = subscriptionTierForRoomCount(colivingRoomCount);
		splitBreakdown.push({
			group: 'COLIVING',
			roomCount: colivingRoomCount,
			tier: colivingTier,
			monthlyPrice: monthlyPrice('COLIVING', colivingTier)
		});
	}

	const pooledMonthlyPrice = sumPrices(pooledBreakdown);
	const splitMonthlyPrice = sumPrices(splitBreakdown.length > 0 ? splitBreakdown : pooledBreakdown);
	// Free allowance áp dụng một lần cho toàn tài khoản, không cho tách để hưởng hai lần Free.
	const canSplit = standardRoomCount >= 4 && colivingRoomCount >= 4;
	const useSplit =
		canSplit &&
		splitMonthlyPrice !== null &&
		(pooledMonthlyPrice === null || splitMonthlyPrice < pooledMonthlyPrice);
	const strategy: PricingStrategy = useSplit ? 'SPLIT' : 'POOLED';
	const breakdown = useSplit ? splitBreakdown : pooledBreakdown;
	const selectedMonthlyPrice = useSplit ? splitMonthlyPrice : pooledMonthlyPrice;
	const limits = TIER_LIMITS[tier];

	return {
		tier,
		recommendedTier,
		period,
		minRooms: limits.minRooms,
		maxRooms: limits.maxRooms,
		strategy,
		splitEligible: canSplit,
		monthlyPrice: selectedMonthlyPrice,
		periodPrice:
			selectedMonthlyPrice === null ? null : selectedMonthlyPrice * (period === 'YEARLY' ? 12 : 1),
		pooledMonthlyPrice,
		splitMonthlyPrice,
		roomCount,
		standardRoomCount,
		colivingRoomCount,
		overCapacity: limits.maxRooms !== null && roomCount > limits.maxRooms,
		requiresContact: selectedMonthlyPrice === null,
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
