import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { paymentTransactions } from '$lib/server/db/schema';
import { requireLandlord } from '$lib/server/authz';
import { and, desc, eq } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const status = url.searchParams.get('status');
		const conditions = [eq(paymentTransactions.landlordId, auth.value)];
		if (status) conditions.push(eq(paymentTransactions.status, status));

		const result = await db.query.paymentTransactions.findMany({
			where: and(...conditions),
			with: { invoice: true, paymentAccount: true },
			orderBy: desc(paymentTransactions.receivedAt),
			limit: 200
		});

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
