import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async () => {
	try {
		const landlords = await db.query.landlordProfiles.findMany({
			with: {
				user: {
					columns: { id: true, name: true, email: true, phone: true, isActive: true, createdAt: true }
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
					columns: { id: true, name: true },
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
				const payosTransactions = paymentTransactions.filter((payment) => payment.provider === 'payos');
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
					user: landlord.user,
					properties: landlord.properties.map((property) => ({
						id: property.id,
						name: property.name,
						_count: { rooms: property.rooms.length }
					})),
					metrics: {
						totalProperties: landlord.properties.length,
						totalRooms: allRooms.length,
						occupiedRooms: allRooms.filter((room) => room.tenantId || room.status !== 'empty').length,
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

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { landlordId, userId, subscriptionType, isActive, subValidUntil } = body;

		if (!landlordId && !userId) {
			return json({ error: 'Missing landlord ID or user ID' }, { status: 400 });
		}

		const updated = await db.transaction(async (tx) => {
			let profile = null;
			let user = null;

			if (landlordId) {
				const updateData: Record<string, unknown> = {};
				if (subscriptionType !== undefined) updateData.subscriptionType = subscriptionType;
				if (subValidUntil) updateData.subValidUntil = new Date(subValidUntil);

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
