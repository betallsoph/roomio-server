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

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlord = await db.query.landlordProfiles.findFirst({
			where: eq(landlordProfiles.id, auth.value),
			columns: { subscriptionType: true, subscriptionPeriod: true, enabledRentalTypes: true }
		});
		if (!landlord) return json({ error: 'Không tìm thấy tài khoản chủ trọ' }, { status: 404 });

		const result = await db
			.select({ count: sql<number>`count(${rooms.id})` })
			.from(properties)
			.leftJoin(rooms, eq(rooms.propertyId, properties.id))
			.where(eq(properties.landlordId, auth.value));

		const roomCount = Number(result[0]?.count ?? 0);
		const tier = SUBSCRIPTION_TIERS.includes(landlord.subscriptionType as SubscriptionTier)
			? (landlord.subscriptionType as SubscriptionTier)
			: 'FREE';
		const period = landlord.subscriptionPeriod === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
		return json(
			calculateSubscriptionQuote({
				tier,
				period,
				rentalTypes: landlord.enabledRentalTypes.split(','),
				roomCount
			})
		);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
