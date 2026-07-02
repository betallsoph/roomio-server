import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, properties, rooms } from '$lib/server/db/schema';
import { requireLandlord } from '$lib/server/authz';
import {
	calculateSubscriptionQuote,
	SUBSCRIPTION_TIERS,
	type SubscriptionTier
} from '$lib/server/subscription-pricing';
import { eq, sql } from 'drizzle-orm';
import { errorMessage } from '$lib/server/api';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlord = await db.query.landlordProfiles.findFirst({
			where: eq(landlordProfiles.id, auth.value),
			columns: { subscriptionType: true, subscriptionPeriod: true, subValidUntil: true }
		});
		if (!landlord) return json({ error: 'Không tìm thấy tài khoản chủ trọ' }, { status: 404 });

		const roomCounts = await db
			.select({ rentalType: properties.rentalType, count: sql<number>`count(${rooms.id})` })
			.from(properties)
			.leftJoin(rooms, eq(rooms.propertyId, properties.id))
			.where(eq(properties.landlordId, auth.value))
			.groupBy(properties.rentalType);

		const standardRoomCount = roomCounts
			.filter((row) => row.rentalType !== 'COLIVING')
			.reduce((sum, row) => sum + Number(row.count), 0);
		const colivingRoomCount = roomCounts
			.filter((row) => row.rentalType === 'COLIVING')
			.reduce((sum, row) => sum + Number(row.count), 0);
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
				validUntil: landlord.subValidUntil
			}
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
