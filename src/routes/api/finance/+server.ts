import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { expenses, invoices, properties, rooms } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';

// Tổng hợp dòng tiền: doanh thu (hóa đơn đã thu) và chi phí theo từng tháng
export const GET: RequestHandler = async ({ url }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const monthCount = Math.min(Number(url.searchParams.get('months')) || 6, 24);

		if (!landlordId) {
			return json({ error: 'Missing landlord ID' }, { status: 400 });
		}

		const invoiceRows = await db
			.select({ month: invoices.month, paidAmount: invoices.paidAmount })
			.from(invoices)
			.where(
				inArray(
					invoices.roomId,
					db
						.select({ id: rooms.id })
						.from(rooms)
						.innerJoin(properties, eq(rooms.propertyId, properties.id))
						.where(eq(properties.landlordId, landlordId))
				)
			);

		const expenseRows = await db
			.select({ date: expenses.date, amount: expenses.amount, category: expenses.category })
			.from(expenses)
			.where(eq(expenses.landlordId, landlordId));

		// Danh sách N tháng gần nhất, định dạng YYYY-MM
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
				expenseByCategory.set(
					exp.category,
					(expenseByCategory.get(exp.category) ?? 0) + exp.amount
				);
			}
		}

		const monthly = months.map((month) => {
			const revenue = revenueByMonth.get(month) ?? 0;
			const expense = expenseByMonth.get(month) ?? 0;
			return { month, revenue, expense, profit: revenue - expense };
		});

		const totalRevenue = monthly.reduce((sum, m) => sum + m.revenue, 0);
		const totalExpense = monthly.reduce((sum, m) => sum + m.expense, 0);

		return json({
			monthly,
			totalRevenue,
			totalExpense,
			totalProfit: totalRevenue - totalExpense,
			expenseByCategory: Object.fromEntries(expenseByCategory)
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
