import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, properties, rooms } from '$lib/server/db/schema';
import {
	calculateSubscriptionQuote,
	pricingGroupForRentalType,
	SUBSCRIPTION_TIERS,
	type SubscriptionTier
} from '$lib/server/subscription-pricing';
import { eq, sql } from 'drizzle-orm';
import { errorMessage } from '$lib/server/api';
import { canonicalRentalType } from '$lib/server/rental-types';
import { requireLandlordMutationActor } from '$lib/server/property-scope';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const landlord = await db.query.landlordProfiles.findFirst({
			where: eq(landlordProfiles.id, landlordId),
			columns: {
				subscriptionType: true,
				subscriptionPeriod: true,
				subValidUntil: true,
				enabledRentalTypes: true,
				subscribedStandardRoomLimit: true,
				subscribedColivingRoomLimit: true
			}
		});
		if (!landlord) return json({ error: 'Không tìm thấy tài khoản chủ trọ' }, { status: 404 });

		const roomCounts = await db
			.select({ rentalType: properties.rentalType, count: sql<number>`count(${rooms.id})` })
			.from(properties)
			.leftJoin(rooms, eq(rooms.propertyId, properties.id))
			.where(eq(properties.landlordId, landlordId))
			.groupBy(properties.rentalType);

		const actualStandardRoomCount = roomCounts
			.filter((row) => pricingGroupForRentalType(row.rentalType) === 'STANDARD')
			.reduce((sum, row) => sum + Number(row.count), 0);
		const actualColivingRoomCount = roomCounts
			.filter((row) => pricingGroupForRentalType(row.rentalType) === 'COLIVING')
			.reduce((sum, row) => sum + Number(row.count), 0);
		const requestedCount = (name: string, actual: number) => {
			const raw = url.searchParams.get(name);
			if (raw === null || raw.trim() === '') return actual;
			const value = Number(raw);
			return Number.isFinite(value) ? Math.max(actual, Math.floor(value), 0) : actual;
		};
		const standardRoomCount = requestedCount('standardRoomCount', actualStandardRoomCount);
		const colivingRoomCount = requestedCount('colivingRoomCount', actualColivingRoomCount);
		const activeTier = SUBSCRIPTION_TIERS.includes(landlord.subscriptionType as SubscriptionTier)
			? (landlord.subscriptionType as SubscriptionTier)
			: 'FREE';
		const activePeriod = landlord.subscriptionPeriod === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
		const requestedTier = url.searchParams.get('tier');
		const requestedPeriod = url.searchParams.get('period');
		const tier = SUBSCRIPTION_TIERS.includes(requestedTier as SubscriptionTier)
			? (requestedTier as SubscriptionTier)
			: activeTier;
		const period =
			requestedPeriod === 'YEARLY' || requestedPeriod === 'MONTHLY'
				? requestedPeriod
				: activePeriod;
		return json({
			...calculateSubscriptionQuote({
				tier,
				period,
				standardRoomCount,
				colivingRoomCount
			}),
			activeSubscription: {
				tier: activeTier,
				period: activePeriod,
				validUntil: landlord.subValidUntil,
				enabledRentalTypes: [
					...new Set(
						landlord.enabledRentalTypes.split(',').filter(Boolean).map(canonicalRentalType)
					)
				],
				standardRoomLimit: landlord.subscribedStandardRoomLimit,
				colivingRoomLimit: landlord.subscribedColivingRoomLimit
			},
			actualRoomCounts: {
				standard: actualStandardRoomCount,
				coliving: actualColivingRoomCount
			}
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
