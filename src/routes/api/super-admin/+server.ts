import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, services, users } from '$lib/server/db/schema';
import { eq, or } from 'drizzle-orm';
import { hashPassword } from '$lib/server/password';
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

const RENTAL_TYPES = ['APARTMENT', 'MOTEL', 'SERVICED_APARTMENT', 'DORM', 'COLIVING'] as const;

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
		.map((type) => String(type).trim().toUpperCase())
		.filter((type): type is (typeof RENTAL_TYPES)[number] =>
			RENTAL_TYPES.includes(type as (typeof RENTAL_TYPES)[number])
		);
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

export const GET: RequestHandler = async () => {
	try {
		const landlords = await db.query.landlordProfiles.findMany({
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
				staffs: {
					with: { user: { columns: { id: true, isActive: true } } }
				},
				services: {
					columns: { id: true, isActive: true }
				},
				notificationQueue: {
					columns: { id: true, status: true }
				},
				subscriptionChangeRequests: {
					columns: { id: true, status: true }
				},
				paymentTransactions: {
					columns: { id: true, amount: true, status: true, receivedAt: true, provider: true }
				},
				properties: {
					columns: { id: true, name: true, rentalType: true },
					with: {
						rooms: {
							columns: { id: true, tenantId: true, status: true, debtAmount: true },
							with: {
								invoices: {
									columns: {
										id: true,
										status: true,
										totalAmount: true,
										paidAmount: true,
										dueDate: true,
										month: true
									}
								}
							}
						}
					}
				}
			}
		});

		const today = new Date().toISOString().slice(0, 10);
		const currentMonth = new Date().toISOString().slice(0, 7);

		// Keep the same response shape as before: properties expose a room count instead of the room list,
		// then add SuperAdmin health metrics for SaaS/support operation.
		const result = landlords
			.map((landlord) => {
				const allRooms = landlord.properties.flatMap((property) => property.rooms);
				const standardRoomCount = landlord.properties
					.filter((property) => pricingGroupForRentalType(property.rentalType) === 'STANDARD')
					.reduce((sum, property) => sum + property.rooms.length, 0);
				const colivingRoomCount = landlord.properties
					.filter((property) => pricingGroupForRentalType(property.rentalType) === 'COLIVING')
					.reduce((sum, property) => sum + property.rooms.length, 0);
				const subscriptionType = normalizeSubscriptionTier(landlord.subscriptionType);
				const subscriptionPeriod = normalizeSubscriptionPeriod(landlord.subscriptionPeriod);
				const subscriptionQuote = calculateSubscriptionQuote({
					tier: subscriptionType,
					period: subscriptionPeriod,
					standardRoomCount,
					colivingRoomCount
				});
				const allInvoices = allRooms.flatMap((room) => room.invoices);
				const unpaidInvoices = allInvoices.filter((invoice) => invoice.status !== 'paid');
				const paymentTransactions = landlord.paymentTransactions;
				const payosTransactions = paymentTransactions.filter(
					(payment) => payment.provider === 'payos'
				);
				const appliedPayments = payosTransactions.filter((payment) => payment.status === 'applied');
				const unmatchedPayments = payosTransactions.filter(
					(payment) => payment.status === 'unmatched' || payment.status === 'ignored'
				);
				const lastPaymentAt = payosTransactions.reduce<Date | null>((latest, payment) => {
					if (!payment.receivedAt) return latest;
					if (!latest || payment.receivedAt > latest) return payment.receivedAt;
					return latest;
				}, null);

				return {
					id: landlord.id,
					userId: landlord.userId,
					subscriptionType,
					subscriptionPeriod,
					subValidUntil: landlord.subValidUntil,
					subscribedStandardRoomLimit: landlord.subscribedStandardRoomLimit,
					subscribedColivingRoomLimit: landlord.subscribedColivingRoomLimit,
					companyName: landlord.companyName,
					enabledRentalTypes: landlord.enabledRentalTypes,
					user: landlord.user,
					properties: landlord.properties.map((property) => ({
						id: property.id,
						name: property.name,
						rentalType: property.rentalType,
						_count: { rooms: property.rooms.length }
					})),
					subscriptionQuote,
					metrics: {
						totalProperties: landlord.properties.length,
						totalRooms: allRooms.length,
						occupiedRooms: allRooms.filter((room) => room.tenantId || room.status !== 'empty')
							.length,
						debtRooms: allRooms.filter((room) => room.status === 'debt').length,
						activeStaff: landlord.staffs.filter((staff) => staff.user?.isActive).length,
						activeServices: landlord.services.filter((service) => service.isActive).length,
						unpaidInvoices: unpaidInvoices.length,
						overdueInvoices: unpaidInvoices.filter((invoice) => invoice.dueDate < today).length,
						unpaidAmount: unpaidInvoices.reduce(
							(sum, invoice) => sum + Math.max(invoice.totalAmount - invoice.paidAmount, 0),
							0
						),
						collectedAmount: allInvoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0),
						currentMonthCollectedAmount: allInvoices
							.filter((invoice) => invoice.month === currentMonth)
							.reduce((sum, invoice) => sum + invoice.paidAmount, 0),
						payosApplied: appliedPayments.length,
						payosUnmatched: unmatchedPayments.length,
						payosAppliedAmount: appliedPayments.reduce((sum, payment) => sum + payment.amount, 0),
						queuedNotifications: landlord.notificationQueue.filter(
							(notification) => notification.status === 'queued'
						).length,
						pendingSubscriptionRequests: landlord.subscriptionChangeRequests.filter(
							(request) => request.status === 'pending'
						).length,
						lastPaymentAt
					}
				};
			})
			.sort((a, b) => a.user.name.localeCompare(b.user.name, 'vi'));

		return json(result);
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
						enabledRentalTypes,
						bankName: 'Vietcombank',
						bankCode: 'VCB',
						accountNumber: '1234567890',
						accountName: name.toUpperCase(),
						bankBranch: 'Chi nhánh TP.HCM'
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
