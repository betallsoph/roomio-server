import { db } from '$lib/server/db';
import { contracts, expenses, invoices, properties, rooms } from '$lib/server/db/schema';
import { and, count, eq, gte, inArray, lte, sql, sum } from 'drizzle-orm';
import { canonicalRentalType, isValidRentalType, type RentalType } from '$lib/server/rental-types';

/** Landlord-scoped room id subquery — use before any invoice/contract aggregate. */
export function scopedRoomIdsSubquery(landlordId: string) {
	return db
		.select({ id: rooms.id })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(eq(properties.landlordId, landlordId));
}

export type DashboardStatsRow = {
	totalRevenue: number;
	emptyRooms: number;
	unpaidInvoices: number;
	expiringContracts: number;
	totalRooms: number;
	occupiedRooms: number;
	roomBreakdownByRentalType: Partial<Record<RentalType, number>>;
};

export async function getDashboardStats(landlordId: string): Promise<DashboardStatsRow> {
	const roomRows = await db
		.select({ id: rooms.id, status: rooms.status })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(eq(properties.landlordId, landlordId));

	const totalRooms = roomRows.length;
	const emptyRooms = roomRows.filter((r) => r.status === 'empty').length;
	const occupiedRooms = totalRooms - emptyRooms;

	const roomIdsSubquery = scopedRoomIdsSubquery(landlordId);

	const unpaidResult = await db
		.select({ value: count() })
		.from(invoices)
		.where(
			and(
				inArray(invoices.roomId, roomIdsSubquery),
				inArray(invoices.status, ['pending', 'overdue', 'partial'])
			)
		);
	const unpaidInvoicesCount = unpaidResult[0]?.value ?? 0;

	const revenueResult = await db
		.select({ total: sum(invoices.paidAmount) })
		.from(invoices)
		.where(inArray(invoices.roomId, roomIdsSubquery));
	const totalRevenue = Number(revenueResult[0]?.total ?? 0);

	const today = new Date();
	const todayStr = today.toISOString().split('T')[0];
	const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

	const expiringRows = await db
		.select({ value: count() })
		.from(contracts)
		.where(
			and(
				inArray(contracts.roomId, roomIdsSubquery),
				eq(contracts.status, 'active'),
				gte(contracts.endDate, todayStr),
				lte(contracts.endDate, in30Days)
			)
		);
	const expiringContracts = expiringRows[0]?.value ?? 0;

	const breakdownRows = await db
		.select({ rentalType: properties.rentalType, count: sql<number>`count(${rooms.id})` })
		.from(properties)
		.leftJoin(rooms, eq(rooms.propertyId, properties.id))
		.where(eq(properties.landlordId, landlordId))
		.groupBy(properties.rentalType);

	const roomBreakdownByRentalType: Partial<Record<RentalType, number>> = {};
	for (const row of breakdownRows) {
		const canonical = canonicalRentalType(row.rentalType);
		if (!isValidRentalType(canonical)) continue;
		roomBreakdownByRentalType[canonical] =
			(roomBreakdownByRentalType[canonical] ?? 0) + Number(row.count);
	}

	return {
		totalRevenue,
		emptyRooms,
		unpaidInvoices: unpaidInvoicesCount,
		expiringContracts,
		totalRooms,
		occupiedRooms,
		roomBreakdownByRentalType
	};
}

export type FinanceMonthlyRow = {
	month: string;
	revenue: number;
	expense: number;
	profit: number;
};

export type FinanceSummary = {
	monthly: FinanceMonthlyRow[];
	totalRevenue: number;
	totalExpense: number;
	totalProfit: number;
	expenseByCategory: Record<string, number>;
};

export async function getFinanceSummary(
	landlordId: string,
	monthCount: number
): Promise<FinanceSummary> {
	const roomIdsSubquery = scopedRoomIdsSubquery(landlordId);

	const invoiceRows = await db
		.select({ month: invoices.month, paidAmount: invoices.paidAmount })
		.from(invoices)
		.where(inArray(invoices.roomId, roomIdsSubquery));

	const expenseRows = await db
		.select({ date: expenses.date, amount: expenses.amount, category: expenses.category })
		.from(expenses)
		.where(eq(expenses.landlordId, landlordId));

	const now = new Date();
	const months: string[] = [];
	for (let i = monthCount - 1; i >= 0; i--) {
		const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
		months.push(`${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`);
	}

	const revenueByMonth = new Map<string, number>();
	for (const inv of invoiceRows) {
		revenueByMonth.set(inv.month, (revenueByMonth.get(inv.month) ?? 0) + inv.paidAmount);
	}

	const expenseByMonth = new Map<string, number>();
	const expenseByCategory = new Map<string, number>();
	for (const exp of expenseRows) {
		const month = exp.date.slice(0, 7);
		expenseByMonth.set(month, (expenseByMonth.get(month) ?? 0) + exp.amount);
		if (months.includes(month)) {
			expenseByCategory.set(exp.category, (expenseByCategory.get(exp.category) ?? 0) + exp.amount);
		}
	}

	const monthly = months.map((month) => {
		const revenue = revenueByMonth.get(month) ?? 0;
		const expense = expenseByMonth.get(month) ?? 0;
		return { month, revenue, expense, profit: revenue - expense };
	});

	const totalRevenue = monthly.reduce((sum, m) => sum + m.revenue, 0);
	const totalExpense = monthly.reduce((sum, m) => sum + m.expense, 0);

	return {
		monthly,
		totalRevenue,
		totalExpense,
		totalProfit: totalRevenue - totalExpense,
		expenseByCategory: Object.fromEntries(expenseByCategory)
	};
}
