import { db } from '$lib/server/db';
import {
	invoices,
	notificationQueue,
	paymentTransactions,
	properties,
	rooms,
	services,
	staffProfiles,
	subscriptionChangeRequests,
	users
} from '$lib/server/db/schema';
import {
	calculateSubscriptionQuote,
	pricingGroupForRentalType,
	SUBSCRIPTION_PERIODS,
	SUBSCRIPTION_TIERS,
	type SubscriptionPeriod,
	type SubscriptionTier
} from '$lib/server/subscription-pricing';
import { canonicalRentalType, isValidRentalType, type RentalType } from '$lib/server/rental-types';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { scopedRoomIdsSubquery } from '$lib/server/aggregate-scope';

export type SuperAdminLandlordMetrics = {
	totalProperties: number;
	totalRooms: number;
	occupiedRooms: number;
	debtRooms: number;
	activeStaff: number;
	activeServices: number;
	unpaidInvoices: number;
	overdueInvoices: number;
	unpaidAmount: number;
	collectedAmount: number;
	currentMonthCollectedAmount: number;
	payosApplied: number;
	payosUnmatched: number;
	payosAppliedAmount: number;
	queuedNotifications: number;
	pendingSubscriptionRequests: number;
	lastPaymentAt: string | null;
};

export type SuperAdminPropertySummary = {
	id: string;
	name: string;
	rentalType: string;
	operatingModel: string;
	roomCount: number;
};

export type SuperAdminLandlordPlatformRow = {
	id: string;
	userId: string;
	subscriptionType: SubscriptionTier;
	subscriptionPeriod: SubscriptionPeriod;
	subValidUntil: Date | string | null;
	subscribedStandardRoomLimit: number | null;
	subscribedColivingRoomLimit: number | null;
	companyName: string | null;
	enabledRentalTypes: string;
	user: {
		id: string;
		name: string;
		email: string;
		phone: string;
		isActive: boolean;
		createdAt: Date | string;
	};
	properties: SuperAdminPropertySummary[];
	subscriptionQuote: ReturnType<typeof calculateSubscriptionQuote>;
	metrics: SuperAdminLandlordMetrics;
};

function normalizeSubscriptionTier(value: unknown): SubscriptionTier {
	return SUBSCRIPTION_TIERS.includes(value as SubscriptionTier)
		? (value as SubscriptionTier)
		: 'FREE';
}

function normalizeSubscriptionPeriod(value: unknown): SubscriptionPeriod {
	return SUBSCRIPTION_PERIODS.includes(value as SubscriptionPeriod)
		? (value as SubscriptionPeriod)
		: 'MONTHLY';
}

function normalizeRentalTypes(value: string): string {
	const normalized = value
		.split(',')
		.map((type) => canonicalRentalType(type))
		.filter((type): type is RentalType => isValidRentalType(type));
	return [...new Set(normalized)].join(',') || 'APARTMENT';
}

async function landlordMetrics(
	landlordId: string,
	today: string,
	currentMonth: string
): Promise<SuperAdminLandlordMetrics> {
	const roomIdsSubquery = scopedRoomIdsSubquery(landlordId);

	const [roomStats, invoiceStats, staffCount, serviceCount, payosStats, queueCount, pendingSubs] =
		await Promise.all([
			db
				.select({
					totalRooms: count(),
					occupiedRooms: sql<number>`count(*) filter (where ${rooms.tenantId} is not null or ${rooms.status} <> 'empty')`,
					debtRooms: sql<number>`count(*) filter (where ${rooms.status} = 'debt')`
				})
				.from(rooms)
				.innerJoin(properties, eq(rooms.propertyId, properties.id))
				.where(eq(properties.landlordId, landlordId)),
			db
				.select({
					unpaidInvoices: sql<number>`count(*) filter (where ${invoices.status} not in ('paid', 'draft'))`,
					overdueInvoices: sql<number>`count(*) filter (where ${invoices.status} not in ('paid', 'draft') and ${invoices.dueDate} < ${today})`,
					unpaidAmount: sql<number>`coalesce(sum(case when ${invoices.status} not in ('paid', 'draft') then greatest(${invoices.totalAmount} - ${invoices.paidAmount}, 0) else 0 end), 0)`,
					collectedAmount: sql<number>`coalesce(sum(${invoices.paidAmount}), 0)`,
					currentMonthCollectedAmount: sql<number>`coalesce(sum(case when ${invoices.month} = ${currentMonth} then ${invoices.paidAmount} else 0 end), 0)`
				})
				.from(invoices)
				.where(inArray(invoices.roomId, roomIdsSubquery)),
			db
				.select({ value: count() })
				.from(staffProfiles)
				.innerJoin(users, eq(staffProfiles.userId, users.id))
				.where(and(eq(staffProfiles.landlordId, landlordId), eq(users.isActive, true))),
			db
				.select({ value: count() })
				.from(services)
				.where(and(eq(services.landlordId, landlordId), eq(services.isActive, true))),
			db
				.select({
					payosApplied: sql<number>`count(*) filter (where ${paymentTransactions.status} = 'applied')`,
					payosUnmatched: sql<number>`count(*) filter (where ${paymentTransactions.status} in ('unmatched', 'ignored'))`,
					payosAppliedAmount: sql<number>`coalesce(sum(case when ${paymentTransactions.status} = 'applied' then ${paymentTransactions.amount} else 0 end), 0)`,
					lastPaymentAt: sql<Date | null>`max(${paymentTransactions.receivedAt})`
				})
				.from(paymentTransactions)
				.where(
					and(
						eq(paymentTransactions.landlordId, landlordId),
						eq(paymentTransactions.provider, 'payos')
					)
				),
			db
				.select({ value: count() })
				.from(notificationQueue)
				.where(
					and(eq(notificationQueue.landlordId, landlordId), eq(notificationQueue.status, 'queued'))
				),
			db
				.select({ value: count() })
				.from(subscriptionChangeRequests)
				.where(
					and(
						eq(subscriptionChangeRequests.landlordId, landlordId),
						eq(subscriptionChangeRequests.status, 'pending')
					)
				)
		]);

	const propertyCount = await db
		.select({ value: count() })
		.from(properties)
		.where(eq(properties.landlordId, landlordId));

	const roomRow = roomStats[0];
	const invoiceRow = invoiceStats[0];
	const payosRow = payosStats[0];

	return {
		totalProperties: propertyCount[0]?.value ?? 0,
		totalRooms: roomRow?.totalRooms ?? 0,
		occupiedRooms: Number(roomRow?.occupiedRooms ?? 0),
		debtRooms: Number(roomRow?.debtRooms ?? 0),
		activeStaff: staffCount[0]?.value ?? 0,
		activeServices: serviceCount[0]?.value ?? 0,
		unpaidInvoices: Number(invoiceRow?.unpaidInvoices ?? 0),
		overdueInvoices: Number(invoiceRow?.overdueInvoices ?? 0),
		unpaidAmount: Number(invoiceRow?.unpaidAmount ?? 0),
		collectedAmount: Number(invoiceRow?.collectedAmount ?? 0),
		currentMonthCollectedAmount: Number(invoiceRow?.currentMonthCollectedAmount ?? 0),
		payosApplied: Number(payosRow?.payosApplied ?? 0),
		payosUnmatched: Number(payosRow?.payosUnmatched ?? 0),
		payosAppliedAmount: Number(payosRow?.payosAppliedAmount ?? 0),
		queuedNotifications: queueCount[0]?.value ?? 0,
		pendingSubscriptionRequests: pendingSubs[0]?.value ?? 0,
		lastPaymentAt: payosRow?.lastPaymentAt
			? payosRow.lastPaymentAt instanceof Date
				? payosRow.lastPaymentAt.toISOString()
				: String(payosRow.lastPaymentAt)
			: null
	};
}

export async function listSuperAdminLandlordPlatformRows(): Promise<
	SuperAdminLandlordPlatformRow[]
> {
	const today = new Date().toISOString().slice(0, 10);
	const currentMonth = new Date().toISOString().slice(0, 7);

	const landlords = await db.query.landlordProfiles.findMany({
		columns: {
			id: true,
			userId: true,
			subscriptionType: true,
			subscriptionPeriod: true,
			subValidUntil: true,
			subscribedStandardRoomLimit: true,
			subscribedColivingRoomLimit: true,
			companyName: true,
			enabledRentalTypes: true
		},
		with: {
			user: {
				columns: {
					id: true,
					name: true,
					email: true,
					phone: true,
					isActive: true,
					createdAt: true
				}
			},
			properties: {
				columns: {
					id: true,
					name: true,
					rentalType: true,
					operatingModel: true
				},
				with: {
					rooms: {
						columns: { id: true }
					}
				}
			}
		}
	});

	const rows: SuperAdminLandlordPlatformRow[] = [];
	for (const landlord of landlords) {
		const subscriptionType = normalizeSubscriptionTier(landlord.subscriptionType);
		const subscriptionPeriod = normalizeSubscriptionPeriod(landlord.subscriptionPeriod);
		const standardRoomCount = landlord.properties
			.filter((property) => pricingGroupForRentalType(property.rentalType) === 'STANDARD')
			.reduce((sum, property) => sum + property.rooms.length, 0);
		const colivingRoomCount = landlord.properties
			.filter((property) => pricingGroupForRentalType(property.rentalType) === 'COLIVING')
			.reduce((sum, property) => sum + property.rooms.length, 0);

		rows.push({
			id: landlord.id,
			userId: landlord.userId,
			subscriptionType,
			subscriptionPeriod,
			subValidUntil: landlord.subValidUntil,
			subscribedStandardRoomLimit: landlord.subscribedStandardRoomLimit,
			subscribedColivingRoomLimit: landlord.subscribedColivingRoomLimit,
			companyName: landlord.companyName,
			enabledRentalTypes: normalizeRentalTypes(landlord.enabledRentalTypes),
			user: {
				id: landlord.user.id,
				name: landlord.user.name,
				email: landlord.user.email ?? '',
				phone: landlord.user.phone ?? '',
				isActive: landlord.user.isActive,
				createdAt: landlord.user.createdAt
			},
			properties: landlord.properties.map((property) => ({
				id: property.id,
				name: property.name,
				rentalType: property.rentalType,
				operatingModel: property.operatingModel,
				roomCount: property.rooms.length
			})),
			subscriptionQuote: calculateSubscriptionQuote({
				tier: subscriptionType,
				period: subscriptionPeriod,
				standardRoomCount,
				colivingRoomCount
			}),
			metrics: await landlordMetrics(landlord.id, today, currentMonth)
		});
	}

	return rows.sort((a, b) => a.user.name.localeCompare(b.user.name, 'vi'));
}
