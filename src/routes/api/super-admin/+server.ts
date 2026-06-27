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

const SUBSCRIPTION_TYPES = ['FREE', 'PREMIUM', 'ENTERPRISE'] as const;
const RENTAL_TYPES = ['APARTMENT', 'MOTEL', 'SERVICED_APARTMENT', 'DORM'] as const;

const DEFAULT_SERVICES = [
	{ name: 'Điện', type: 'METERED', defaultRate: 3500 },
	{ name: 'Nước', type: 'METERED', defaultRate: 15000 },
	{ name: 'Wifi', type: 'FLAT_ROOM', defaultRate: 100000 },
	{ name: 'Rác sinh hoạt', type: 'FLAT_PERSON', defaultRate: 30000 },
	{ name: 'Gửi xe máy', type: 'FLAT_VEHICLE', defaultRate: 100000 }
];

function normalizeRentalTypes(value: unknown): string {
	const rawTypes = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	const normalized = rawTypes
		.map((type) => String(type).trim().toUpperCase())
		.filter((type): type is (typeof RENTAL_TYPES)[number] =>
			RENTAL_TYPES.includes(type as (typeof RENTAL_TYPES)[number])
		);
	const unique = [...new Set(normalized)];
	return unique.length > 0 ? unique.join(',') : 'APARTMENT';
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
					subscriptionType: landlord.subscriptionType,
					subValidUntil: landlord.subValidUntil,
					companyName: landlord.companyName,
					enabledRentalTypes: landlord.enabledRentalTypes,
					user: landlord.user,
					properties: landlord.properties.map((property) => ({
						id: property.id,
						name: property.name,
						rentalType: property.rentalType,
						_count: { rooms: property.rooms.length }
					})),
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
				: requiredEnum(body.subscriptionType, 'gói dịch vụ', SUBSCRIPTION_TYPES);
		const subValidUntil =
			typeof body.subValidUntil === 'string' && body.subValidUntil
				? new Date(body.subValidUntil)
				: null;
		const enabledRentalTypes = normalizeRentalTypes(body.enabledRentalTypes);

		if (password.length < 6) {
			return json({ error: 'Mật khẩu phải dài ít nhất 6 ký tự' }, { status: 400 });
		}
		if (subValidUntil && Number.isNaN(subValidUntil.getTime())) {
			return json({ error: 'Hạn gói dịch vụ không hợp lệ' }, { status: 400 });
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
						subValidUntil,
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
		const { landlordId, userId, subscriptionType, isActive, subValidUntil, enabledRentalTypes } =
			body;

		if (!landlordId && !userId) {
			return json({ error: 'Missing landlord ID or user ID' }, { status: 400 });
		}

		const updated = await db.transaction(async (tx) => {
			let profile = null;
			let user = null;

			if (landlordId) {
				const updateData: Record<string, unknown> = {};
				if (subscriptionType !== undefined) updateData.subscriptionType = subscriptionType;
				if (subValidUntil !== undefined) {
					updateData.subValidUntil = subValidUntil ? new Date(subValidUntil) : null;
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
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
