import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	landlordProfiles,
	properties,
	rooms,
	subscriptionChangeRequests
} from '$lib/server/db/schema';
import { errorMessage } from '$lib/server/api';
import {
	calculateSubscriptionQuote,
	SUBSCRIPTION_PERIODS,
	SUBSCRIPTION_TIERS,
	subscriptionExpiryDate,
	type SubscriptionPeriod,
	type SubscriptionTier
} from '$lib/server/subscription-pricing';

const RENTAL_TYPES = ['APARTMENT', 'MOTEL', 'SERVICED_APARTMENT', 'DORM', 'COLIVING'];

async function roomCounts(landlordId: string) {
	const rows = await db
		.select({ rentalType: properties.rentalType, count: sql<number>`count(${rooms.id})` })
		.from(properties)
		.leftJoin(rooms, eq(rooms.propertyId, properties.id))
		.where(eq(properties.landlordId, landlordId))
		.groupBy(properties.rentalType);
	return {
		standardRoomCount: rows
			.filter((row) => row.rentalType !== 'COLIVING')
			.reduce((sum, row) => sum + Number(row.count), 0),
		colivingRoomCount: rows
			.filter((row) => row.rentalType === 'COLIVING')
			.reduce((sum, row) => sum + Number(row.count), 0)
	};
}

function requestedLandlordId(session: App.Locals['session'], url: URL): string | null {
	if (session?.role === 'LANDLORD') return session.landlordProfileId ?? null;
	if (session?.role === 'SUPER_ADMIN') return url.searchParams.get('landlordId');
	return null;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const landlordId = requestedLandlordId(locals.session, url);
		if (!landlordId) return json({ error: 'Không có quyền xem yêu cầu này' }, { status: 403 });

		const requests = await db.query.subscriptionChangeRequests.findMany({
			where: eq(subscriptionChangeRequests.landlordId, landlordId),
			orderBy: [desc(subscriptionChangeRequests.createdAt)]
		});
		return json(requests);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (locals.session?.role !== 'LANDLORD' || !locals.session.landlordProfileId) {
			return json({ error: 'Chỉ chủ trọ được gửi yêu cầu đổi gói' }, { status: 403 });
		}
		const landlordId = locals.session.landlordProfileId;
		const body = await request.json();
		if (!SUBSCRIPTION_TIERS.includes(body.requestedTier as SubscriptionTier)) {
			return json({ error: 'Gói yêu cầu không hợp lệ' }, { status: 400 });
		}
		if (!SUBSCRIPTION_PERIODS.includes(body.requestedPeriod as SubscriptionPeriod)) {
			return json({ error: 'Thời hạn yêu cầu không hợp lệ' }, { status: 400 });
		}

		const pending = await db.query.subscriptionChangeRequests.findFirst({
			where: and(
				eq(subscriptionChangeRequests.landlordId, landlordId),
				eq(subscriptionChangeRequests.status, 'pending')
			)
		});
		if (pending) {
			return json({ error: 'Bạn đang có một yêu cầu chờ duyệt' }, { status: 409 });
		}

		const landlord = await db.query.landlordProfiles.findFirst({
			where: eq(landlordProfiles.id, landlordId),
			columns: {
				subscriptionType: true,
				subscriptionPeriod: true,
				enabledRentalTypes: true,
				subscribedStandardRoomLimit: true,
				subscribedColivingRoomLimit: true
			}
		});
		if (!landlord) return json({ error: 'Không tìm thấy tài khoản chủ trọ' }, { status: 404 });
		const currentRentalTypes = new Set(landlord.enabledRentalTypes.split(',').filter(Boolean));
		const roomAdditions: Record<string, number> = {};
		if (
			body.roomAdditions &&
			typeof body.roomAdditions === 'object' &&
			!Array.isArray(body.roomAdditions)
		) {
			for (const [rawType, rawCount] of Object.entries(body.roomAdditions)) {
				const type = rawType.trim().toUpperCase();
				const count = Math.floor(Number(rawCount));
				if (RENTAL_TYPES.includes(type) && Number.isFinite(count) && count > 0) {
					roomAdditions[type] = count;
				}
			}
		}
		const legacyRequestedTypes = Array.isArray(body.addRentalTypes)
			? body.addRentalTypes.map((type: unknown) => String(type).trim().toUpperCase())
			: [];
		const requestedRentalTypes = [
			...new Set([...Object.keys(roomAdditions), ...legacyRequestedTypes])
		].filter((type) => RENTAL_TYPES.includes(type) && !currentRentalTypes.has(type));
		const actualCounts = await roomCounts(landlordId);
		const baseStandardRoomCount =
			landlord.subscribedStandardRoomLimit ?? actualCounts.standardRoomCount;
		const baseColivingRoomCount =
			landlord.subscribedColivingRoomLimit ?? actualCounts.colivingRoomCount;
		const requestedCount = (value: unknown, actual: number) => {
			const count = Number(value);
			return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : actual;
		};
		const hasRoomAdditions = Object.keys(roomAdditions).length > 0;
		const counts = hasRoomAdditions
			? {
					standardRoomCount:
						baseStandardRoomCount +
						Object.entries(roomAdditions)
							.filter(([type]) => type !== 'COLIVING')
							.reduce((sum, [, count]) => sum + count, 0),
					colivingRoomCount: baseColivingRoomCount + (roomAdditions.COLIVING ?? 0)
				}
			: {
					standardRoomCount: requestedCount(body.standardRoomCount, baseStandardRoomCount),
					colivingRoomCount: requestedCount(body.colivingRoomCount, baseColivingRoomCount)
				};
		if (
			counts.standardRoomCount < actualCounts.standardRoomCount ||
			counts.colivingRoomCount < actualCounts.colivingRoomCount
		) {
			return json(
				{ error: 'Số phòng dự kiến không được thấp hơn số phòng đang có' },
				{ status: 400 }
			);
		}
		const futureRentalTypes = new Set([...currentRentalTypes, ...requestedRentalTypes]);
		if (counts.colivingRoomCount > 0 && !futureRentalTypes.has('COLIVING')) {
			return json(
				{ error: 'Cần chọn thêm loại hình Co-living cho số phòng dự kiến' },
				{ status: 400 }
			);
		}
		if (
			counts.standardRoomCount > 0 &&
			![...futureRentalTypes].some((type) => type !== 'COLIVING')
		) {
			return json({ error: 'Cần chọn một loại hình phòng tiêu chuẩn' }, { status: 400 });
		}
		const quote = calculateSubscriptionQuote({
			tier: body.requestedTier as SubscriptionTier,
			period: body.requestedPeriod as SubscriptionPeriod,
			...counts
		});
		if (quote.overCapacity) {
			return json({ error: 'Gói yêu cầu không đủ cho số phòng dự kiến' }, { status: 400 });
		}
		if (quote.recommendedTier !== body.requestedTier) {
			return json({ error: 'Gói yêu cầu chưa khớp với số phòng dự kiến' }, { status: 400 });
		}
		const allocationChanged =
			landlord.subscribedStandardRoomLimit !== counts.standardRoomCount ||
			landlord.subscribedColivingRoomLimit !== counts.colivingRoomCount;
		if (
			landlord.subscriptionType === body.requestedTier &&
			landlord.subscriptionPeriod === body.requestedPeriod &&
			requestedRentalTypes.length === 0 &&
			!allocationChanged
		) {
			return json({ error: 'Bạn chưa chọn thay đổi nào' }, { status: 400 });
		}

		const created = (
			await db
				.insert(subscriptionChangeRequests)
				.values({
					landlordId,
					requestedTier: body.requestedTier,
					requestedPeriod: body.requestedPeriod,
					currentTier: landlord.subscriptionType,
					currentPeriod: landlord.subscriptionPeriod,
					requestedRentalTypes:
						requestedRentalTypes.length > 0 ? requestedRentalTypes.join(',') : null,
					requestedRoomAdditions: hasRoomAdditions ? JSON.stringify(roomAdditions) : null,
					standardRoomCount: counts.standardRoomCount,
					colivingRoomCount: counts.colivingRoomCount,
					quotedMonthlyPrice: quote.monthlyPrice,
					quotedPeriodPrice: quote.periodPrice,
					pricingStrategy: quote.strategy,
					note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null
				})
				.returning()
		)[0];
		return json(created, { status: 201 });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		if (!body.id) return json({ error: 'Thiếu mã yêu cầu' }, { status: 400 });

		const existing = await db.query.subscriptionChangeRequests.findFirst({
			where: eq(subscriptionChangeRequests.id, body.id)
		});
		if (!existing) return json({ error: 'Không tìm thấy yêu cầu' }, { status: 404 });
		if (existing.status !== 'pending') {
			return json({ error: 'Yêu cầu này đã được xử lý' }, { status: 409 });
		}

		if (locals.session?.role === 'LANDLORD') {
			if (existing.landlordId !== locals.session.landlordProfileId || body.action !== 'cancel') {
				return json({ error: 'Không có quyền hủy yêu cầu này' }, { status: 403 });
			}
			const cancelled = (
				await db
					.update(subscriptionChangeRequests)
					.set({ status: 'cancelled' })
					.where(eq(subscriptionChangeRequests.id, existing.id))
					.returning()
			)[0];
			return json(cancelled);
		}

		if (locals.session?.role !== 'SUPER_ADMIN') {
			return json({ error: 'Chỉ Super Admin được xử lý yêu cầu' }, { status: 403 });
		}
		if (body.action !== 'approve' && body.action !== 'reject') {
			return json({ error: 'Thao tác không hợp lệ' }, { status: 400 });
		}
		if (body.action === 'approve') {
			const counts = await roomCounts(existing.landlordId);
			if (
				counts.standardRoomCount > existing.standardRoomCount ||
				counts.colivingRoomCount > existing.colivingRoomCount
			) {
				return json(
					{ error: 'Số phòng thực tế đã vượt mức dự kiến; chủ trọ cần gửi lại yêu cầu mới' },
					{ status: 409 }
				);
			}
		}
		const profileForApproval =
			body.action === 'approve'
				? await db.query.landlordProfiles.findFirst({
						where: eq(landlordProfiles.id, existing.landlordId),
						columns: {
							enabledRentalTypes: true,
							subscriptionType: true,
							subscriptionPeriod: true
						}
					})
				: null;

		const reviewed = await db.transaction(async (tx) => {
			if (body.action === 'approve') {
				const tier = existing.requestedTier as SubscriptionTier;
				const period = existing.requestedPeriod as SubscriptionPeriod;
				const enabledRentalTypes = new Set(
					(profileForApproval?.enabledRentalTypes || 'APARTMENT').split(',').filter(Boolean)
				);
				for (const type of (existing.requestedRentalTypes || '').split(',').filter(Boolean)) {
					enabledRentalTypes.add(type);
				}
				const subscriptionChanged =
					profileForApproval?.subscriptionType !== tier ||
					profileForApproval?.subscriptionPeriod !== period;
				await tx
					.update(landlordProfiles)
					.set({
						enabledRentalTypes: [...enabledRentalTypes].join(','),
						subscribedStandardRoomLimit: existing.standardRoomCount,
						subscribedColivingRoomLimit: existing.colivingRoomCount,
						...(subscriptionChanged
							? {
									subscriptionType: tier,
									subscriptionPeriod: period,
									subValidUntil: tier === 'FREE' ? null : subscriptionExpiryDate(period)
								}
							: {})
					})
					.where(eq(landlordProfiles.id, existing.landlordId));
			}
			return (
				await tx
					.update(subscriptionChangeRequests)
					.set({
						status: body.action === 'approve' ? 'approved' : 'rejected',
						adminNote:
							typeof body.adminNote === 'string'
								? body.adminNote.trim().slice(0, 500) || null
								: null,
						reviewedAt: new Date()
					})
					.where(eq(subscriptionChangeRequests.id, existing.id))
					.returning()
			)[0];
		});
		return json(reviewed);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
