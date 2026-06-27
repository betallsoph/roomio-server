import { db } from '../src/lib/server/db';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/lib/server/db/schema';

async function main() {
    try {
		const client = new PGlite('./pgdata');
		const db = drizzle(client, { schema });
		const landlords = await db.query.landlordProfiles.findMany({ with: {
			user: { columns: {
				id: true,
				name: true,
				email: true,
				phone: true,
				isActive: true,
				createdAt: true
			} },
			staffs: { with: { user: { columns: {
				id: true,
				isActive: true
			} } } },
			services: { columns: {
				id: true,
				isActive: true
			} },
			notificationQueue: { columns: {
				id: true,
				status: true
			} },
			paymentTransactions: { columns: {
				id: true,
				amount: true,
				status: true,
				receivedAt: true,
				provider: true
			} },
			properties: {
				columns: {
					id: true,
					name: true,
					rentalType: true
				},
				with: { rooms: {
					columns: {
						id: true,
						tenantId: true,
						status: true,
						debtAmount: true
					},
					with: { invoices: { columns: {
						id: true,
						status: true,
						totalAmount: true,
						paidAmount: true,
						dueDate: true,
						month: true
					} } }
				} }
			}
		} });
        console.log("Success! Returned", landlords.length, "records");
    } catch (e: any) {
        console.dir(e, { depth: null });
    }
    process.exit(0);
}

main();
