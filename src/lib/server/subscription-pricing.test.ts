import assert from 'node:assert/strict';
import test from 'node:test';

const { calculateSubscriptionQuote, subscriptionTierForRoomCount } = await import(
	'./subscription-pricing.js'
);

test('subscriptionTierForRoomCount maps room counts to tiers', () => {
	const cases: Array<[number, string]> = [
		[0, 'FREE'],
		[3, 'FREE'],
		[4, 'ROOMS_4_10'],
		[10, 'ROOMS_4_10'],
		[11, 'ROOMS_11_25'],
		[25, 'ROOMS_11_25'],
		[26, 'ROOMS_26_50'],
		[50, 'ROOMS_26_50'],
		[51, 'ROOMS_51_80'],
		[80, 'ROOMS_51_80'],
		[81, 'ROOMS_81_100'],
		[100, 'ROOMS_81_100'],
		[101, 'ROOMS_101_150'],
		[150, 'ROOMS_101_150'],
		[151, 'ROOMS_151_PLUS']
	];

	for (const [roomCount, expectedTier] of cases) {
		assert.equal(
			subscriptionTierForRoomCount(roomCount),
			expectedTier,
			`roomCount ${roomCount}`
		);
	}
});

test('7 std + 10 col uses SPLIT with per-group breakdown', () => {
	const quote = calculateSubscriptionQuote({
		tier: 'ROOMS_11_25',
		period: 'MONTHLY',
		standardRoomCount: 7,
		colivingRoomCount: 10
	});

	assert.equal(quote.tier, 'ROOMS_11_25');
	assert.equal(quote.recommendedTier, 'ROOMS_11_25');
	assert.equal(quote.splitEligible, true);
	assert.equal(quote.strategy, 'SPLIT');
	assert.equal(quote.monthlyPrice, 278_000);
	assert.deepEqual(quote.breakdown, [
		{ group: 'STANDARD', roomCount: 7, tier: 'ROOMS_4_10', monthlyPrice: 149_000 },
		{ group: 'COLIVING', roomCount: 10, tier: 'ROOMS_4_10', monthlyPrice: 129_000 }
	]);
});

test('4+4 uses POOLED pricing at ROOMS_4_10', () => {
	const monthly = calculateSubscriptionQuote({
		tier: 'ROOMS_4_10',
		period: 'MONTHLY',
		standardRoomCount: 4,
		colivingRoomCount: 4
	});

	assert.equal(monthly.recommendedTier, 'ROOMS_4_10');
	assert.equal(monthly.splitEligible, true);
	assert.equal(monthly.strategy, 'POOLED');
	assert.equal(monthly.monthlyPrice, 149_000);

	const yearly = calculateSubscriptionQuote({
		tier: 'ROOMS_4_10',
		period: 'YEARLY',
		standardRoomCount: 4,
		colivingRoomCount: 4
	});

	assert.equal(yearly.periodPrice, 1_788_000);
});

test('8+8 uses SPLIT at ROOMS_11_25 total tier', () => {
	const quote = calculateSubscriptionQuote({
		tier: 'ROOMS_11_25',
		period: 'MONTHLY',
		standardRoomCount: 8,
		colivingRoomCount: 8
	});

	assert.equal(quote.recommendedTier, 'ROOMS_11_25');
	assert.equal(quote.splitEligible, true);
	assert.equal(quote.strategy, 'SPLIT');
	assert.equal(quote.monthlyPrice, 278_000);
});

test('3+0 is free on pooled STANDARD pricing', () => {
	const quote = calculateSubscriptionQuote({
		tier: 'FREE',
		period: 'MONTHLY',
		standardRoomCount: 3,
		colivingRoomCount: 0
	});

	assert.equal(quote.recommendedTier, 'FREE');
	assert.equal(quote.splitEligible, false);
	assert.equal(quote.strategy, 'POOLED');
	assert.equal(quote.monthlyPrice, 0);
});

test('0+10 uses POOLED COLIVING pricing', () => {
	const quote = calculateSubscriptionQuote({
		tier: 'ROOMS_4_10',
		period: 'MONTHLY',
		standardRoomCount: 0,
		colivingRoomCount: 10
	});

	assert.equal(quote.recommendedTier, 'ROOMS_4_10');
	assert.equal(quote.strategy, 'POOLED');
	assert.equal(quote.monthlyPrice, 129_000);
});

test('3+3 totals 6 rooms and is not free', () => {
	const quote = calculateSubscriptionQuote({
		tier: 'ROOMS_4_10',
		period: 'MONTHLY',
		standardRoomCount: 3,
		colivingRoomCount: 3
	});

	assert.equal(quote.roomCount, 6);
	assert.equal(quote.splitEligible, false);
	assert.equal(quote.recommendedTier, 'ROOMS_4_10');
	assert.equal(quote.strategy, 'POOLED');
	assert.equal(quote.monthlyPrice, 149_000);
	assert.notEqual(quote.monthlyPrice, 0);
});

test('200+0 requires contact at ROOMS_151_PLUS', () => {
	const quote = calculateSubscriptionQuote({
		tier: 'ROOMS_151_PLUS',
		period: 'MONTHLY',
		standardRoomCount: 200,
		colivingRoomCount: 0
	});

	assert.equal(quote.recommendedTier, 'ROOMS_151_PLUS');
	assert.equal(quote.monthlyPrice, null);
	assert.equal(quote.requiresContact, true);
});
