import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, services, users } from '$lib/server/db/schema';
import { eq, or } from 'drizzle-orm';
import { hashPassword } from '$lib/server/password';
import { listSuperAdminLandlordPlatformRows } from '$lib/server/aggregate-scope';
import { toSuperAdminLandlordListDto } from '$lib/server/dto/super-admin';
import {
	requiredEmail,
	requiredEnum,
	requiredPhone,
	requiredString,
	ValidationError
} from '$lib/server/validation';
import {
	calculateSubscriptionQuote,
	pricingGroupForRentalType,
	SUBSCRIPTION_PERIODS,
	SUBSCRIPTION_TIERS,
	subscriptionExpiryDate,
	subscriptionTierLimits,
	type SubscriptionPeriod,
	type SubscriptionTier
} from '$lib/server/subscription-pricing';
import { canonicalRentalType, isValidRentalType, type RentalType } from '$lib/server/rental-types';

const DEFAULT_SERVICES = [
	{ name: 'Điện', type: 'METERED', defaultRate: 3500 },
	{ name: 'Nước', type: 'METERED', defaultRate: 15000 },
	{ name: 'Wifi', type: 'FLAT_ROOM', defaultRate: 100000 },
	{ name: 'Rác sinh hoạt', type: 'FLAT_PERSON', defaultRate: 30000 },
	{ name: 'Gửi xe máy', type: 'FLAT_VEHICLE', defaultRate: 100000 }
];

function normalizeRentalTypes(value: unknown): string {
	if (value === undefined || value === null) return 'APARTMENT';
	const rawTypes = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	const normalized = rawTypes
		.map((type) => canonicalRentalType(type))
		.filter((type): type is RentalType => isValidRentalType(type));
	const unique = [...new Set(normalized)];
	if (unique.length === 0) throw new ValidationError('Phải chọn ít nhất một loại hình');
	return unique.join(',');
}

function normalizeRoomLimit(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const count = Number(value);
	if (!Number.isFinite(count) || count < 0) throw new ValidationError('Số phòng không hợp lệ');
	return Math.floor(count);
}

export const GET: RequestHandler = async () => {
	try {
		const rows = await listSuperAdminLandlordPlatformRows();
		return json(toSuperAdminLandlordListDto(rows));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const name = requiredString(body.name, 'họ tên chủ trọ', 120);
		const email = requiredEmail(body.email);
		const phone = requiredPhone(body.phone);
		const password = requiredString(body.password, 'mật khẩu', 128);
		const companyName =
			typeof body.companyName === 'string' && body.companyName.trim()
				? body.companyName.trim().slice(0, 255)
				: `${name} PMS`;
		const subscriptionType =
			body.subscriptionType === undefined || body.subscriptionType === ''
				? 'FREE'
				: requiredEnum(body.subscriptionType, 'gói dịch vụ', SUBSCRIPTION_TIERS);
		const subscriptionPeriod =
			body.subscriptionPeriod === undefined || body.subscriptionPeriod === ''
				? 'MONTHLY'
				: requiredEnum(body.subscriptionPeriod, 'thời hạn gói', SUBSCRIPTION_PERIODS);
		const subValidUntil =
			subscriptionType === 'FREE' ? null : subscriptionExpiryDate(subscriptionPeriod);
		const enabledRentalTypes = normalizeRentalTypes(body.enabledRentalTypes);
		const standardRoomLimit = normalizeRoomLimit(body.standardRoomLimit);
		const colivingRoomLimit = normalizeRoomLimit(body.colivingRoomLimit);
		const initialRoomLimit = (standardRoomLimit ?? 0) + (colivingRoomLimit ?? 0);
		const initialTierLimits = subscriptionTierLimits(subscriptionType);
		if (initialTierLimits.maxRooms !== null && initialRoomLimit > initialTierLimits.maxRooms) {
			return json(
				{ error: `Gói ban đầu chỉ cho phép tối đa ${initialTierLimits.maxRooms} phòng` },
				{ status: 400 }
			);
		}
		const enabledTypeSet = new Set(enabledRentalTypes.split(',').filter(Boolean));
		if (
			(colivingRoomLimit ?? 0) > 0 &&
			![...enabledTypeSet].some((type) => pricingGroupForRentalType(type) === 'COLIVING')
		) {
			return json({ error: 'Cần bật loại hình Chung cư hoặc Co-living' }, { status: 400 });
		}
		if (
			(standardRoomLimit ?? 0) > 0 &&
			![...enabledTypeSet].some((type) => pricingGroupForRentalType(type) === 'STANDARD')
		) {
			return json({ error: 'Cần bật một loại hình phòng tiêu chuẩn' }, { status: 400 });
		}

		if (password.length < 6) {
			return json({ error: 'Mật khẩu phải dài ít nhất 6 ký tự' }, { status: 400 });
		}
		const existingUser = await db.query.users.findFirst({
			where: or(eq(users.email, email), eq(users.phone, phone)),
			columns: { id: true }
		});
		if (existingUser) {
			return json({ error: 'Email hoặc số điện thoại đã được đăng ký' }, { status: 400 });
		}

		const passwordHash = await hashPassword(password);
		const created = await db.transaction(async (tx) => {
			const user = (
				await tx
					.insert(users)
					.values({
						email,
						phone,
						passwordHash,
						name,
						role: 'LANDLORD',
						isActive: true
					})
					.returning()
			)[0];

			const landlord = (
				await tx
					.insert(landlordProfiles)
					.values({
						userId: user.id,
						companyName,
						subscriptionType,
						subscriptionPeriod,
						subValidUntil,
						subscribedStandardRoomLimit: standardRoomLimit,
						subscribedColivingRoomLimit: colivingRoomLimit,
						enabledRentalTypes
					})
					.returning()
			)[0];

			await tx.insert(services).values(
				DEFAULT_SERVICES.map((service) => ({
					...service,
					landlordId: landlord.id,
					isActive: true
				}))
			);

			return {
				id: landlord.id,
				userId: user.id,
				name: user.name,
				email: user.email,
				phone: user.phone,
				companyName: landlord.companyName,
				subscriptionType: landlord.subscriptionType,
				subscriptionPeriod: landlord.subscriptionPeriod,
				subValidUntil: landlord.subValidUntil,
				enabledRentalTypes: landlord.enabledRentalTypes
			};
		});

		return json(created, { status: 201 });
	} catch (error) {
		if (error instanceof ValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const {
			landlordId,
			userId,
			subscriptionType,
			subscriptionPeriod,
			isActive,
			enabledRentalTypes,
			standardRoomLimit,
			colivingRoomLimit
		} = body;

		if (!landlordId && !userId) {
			return json({ error: 'Missing landlord ID or user ID' }, { status: 400 });
		}

		const updated = await db.transaction(async (tx) => {
			let profile = null;
			let user = null;

			if (landlordId) {
				const updateData: Record<string, unknown> = {};
				const normalizedStandardLimit = normalizeRoomLimit(standardRoomLimit);
				const normalizedColivingLimit = normalizeRoomLimit(colivingRoomLimit);
				if (subscriptionType !== undefined || subscriptionPeriod !== undefined) {
					const tier = requiredEnum(subscriptionType ?? 'FREE', 'gói dịch vụ', SUBSCRIPTION_TIERS);
					const period = requiredEnum(
						subscriptionPeriod ?? 'MONTHLY',
						'thời hạn gói',
						SUBSCRIPTION_PERIODS
					);
					updateData.subscriptionType = tier;
					updateData.subscriptionPeriod = period;
					updateData.subValidUntil = tier === 'FREE' ? null : subscriptionExpiryDate(period);
					if (normalizedStandardLimit !== undefined || normalizedColivingLimit !== undefined) {
						const totalLimit = (normalizedStandardLimit ?? 0) + (normalizedColivingLimit ?? 0);
						const limits = subscriptionTierLimits(tier);
						if (limits.maxRooms !== null && totalLimit > limits.maxRooms) {
							throw new ValidationError(`Gói này chỉ cho phép tối đa ${limits.maxRooms} phòng`);
						}
					}
				}
				if (normalizedStandardLimit !== undefined) {
					updateData.subscribedStandardRoomLimit = normalizedStandardLimit;
				}
				if (normalizedColivingLimit !== undefined) {
					updateData.subscribedColivingRoomLimit = normalizedColivingLimit;
				}
				if (enabledRentalTypes !== undefined) {
					updateData.enabledRentalTypes = normalizeRentalTypes(enabledRentalTypes);
				}

				if (Object.keys(updateData).length > 0) {
					profile = (
						await tx
							.update(landlordProfiles)
							.set(updateData)
							.where(eq(landlordProfiles.id, landlordId))
							.returning()
					)[0];
				}
			}

			if (userId && isActive !== undefined) {
				user = (
					await tx.update(users).set({ isActive }).where(eq(users.id, userId)).returning()
				)[0];
			}

			return { profile, user };
		});

		return json(updated);
	} catch (error) {
		if (error instanceof ValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
