import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { properties, rooms, invoices, contracts } from '$lib/server/db/schema';
import { and, count, eq, gte, inArray, lte, sum } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');

		if (!landlordId) {
			return json({ error: 'Missing landlord ID' }, { status: 400 });
		}

		// 1. Fetch all rooms belonging to the landlord's properties
		const roomRows = await db
			.select({ id: rooms.id, status: rooms.status })
			.from(rooms)
			.innerJoin(properties, eq(rooms.propertyId, properties.id))
			.where(eq(properties.landlordId, landlordId));

		const totalRooms = roomRows.length;
		const emptyRooms = roomRows.filter((r) => r.status === 'empty').length;
		const occupiedRooms = totalRooms - emptyRooms;

		const roomIdsSubquery = db
			.select({ id: rooms.id })
			.from(rooms)
			.innerJoin(properties, eq(rooms.propertyId, properties.id))
			.where(eq(properties.landlordId, landlordId));

		// 2. Count unpaid invoices
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

		// 3. Calculate total revenue (sum of paidAmount of all invoices)
		const revenueResult = await db
			.select({ total: sum(invoices.paidAmount) })
			.from(invoices)
			.where(inArray(invoices.roomId, roomIdsSubquery));
		const totalRevenue = Number(revenueResult[0]?.total ?? 0);

		// 4. Count contracts expiring within the next 30 days
		const today = new Date();
		const todayStr = today.toISOString().split('T')[0];
		const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
			.toISOString()
			.split('T')[0];

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

		return json({
			totalRevenue,
			emptyRooms,
			unpaidInvoices: unpaidInvoicesCount,
			expiringContracts,
			totalRooms,
			occupiedRooms
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
