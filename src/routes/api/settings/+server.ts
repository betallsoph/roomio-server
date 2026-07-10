import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, paymentAccounts } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireLandlord } from '$lib/server/authz';
import { ensureDefaultPaymentAccount } from '$lib/server/payment-accounts';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;

		const landlordProfile = await db.query.landlordProfiles.findFirst({
			where: eq(landlordProfiles.id, landlordId),
			with: {
				user: {
					columns: { name: true, email: true, phone: true }
				}
			}
		});

		if (!landlordProfile) {
			return json({ error: 'Landlord profile not found' }, { status: 404 });
		}

		return json(landlordProfile);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;

		const body = await request.json();
		const { companyName, bankName, bankCode, accountNumber, accountName, bankBranch, momoNumber } =
			body;

		const updateData: Record<string, unknown> = {};
		if (companyName !== undefined) updateData.companyName = companyName;
		if (bankName !== undefined) updateData.bankName = bankName;
		if (bankCode !== undefined) updateData.bankCode = bankCode;
		if (accountNumber !== undefined) updateData.accountNumber = accountNumber;
		if (accountName) updateData.accountName = accountName.toUpperCase();
		if (bankBranch !== undefined) updateData.bankBranch = bankBranch;
		if (momoNumber !== undefined) updateData.momoNumber = momoNumber || null;

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		const updated = await db
			.update(landlordProfiles)
			.set(updateData)
			.where(eq(landlordProfiles.id, landlordId))
			.returning();
		if (
			bankName !== undefined ||
			bankCode !== undefined ||
			accountNumber !== undefined ||
			accountName !== undefined ||
			bankBranch !== undefined ||
			momoNumber !== undefined
		) {
			const account = await ensureDefaultPaymentAccount(landlordId);
			await db
				.update(paymentAccounts)
				.set({
					...(bankName !== undefined ? { bankName } : {}),
					...(bankCode !== undefined ? { bankCode } : {}),
					...(accountNumber !== undefined ? { accountNumber } : {}),
					...(accountName ? { accountName: accountName.toUpperCase() } : {}),
					...(bankBranch !== undefined ? { bankBranch } : {}),
					...(momoNumber !== undefined ? { momoNumber: momoNumber || null } : {})
				})
				.where(eq(paymentAccounts.id, account.id));
		}

		return json(updated[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
