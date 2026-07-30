import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, paymentAccounts } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { pickSettingsWriteInput, toSettingsDto } from '$lib/server/dto/settings';
import { ensureDefaultPaymentAccount } from '$lib/server/payment-accounts';
import { requireLandlordMutationActor } from '$lib/server/property-scope';
import { encryptSecret } from '$lib/server/secrets';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const landlordProfile = await db.query.landlordProfiles.findFirst({
			where: eq(landlordProfiles.id, landlordId),
			columns: {
				id: true,
				companyName: true,
				bankName: true,
				bankCode: true,
				accountNumber: true,
				accountName: true,
				bankBranch: true,
				momoNumber: true,
				payosClientId: true,
				payosApiKeyEnc: true,
				payosChecksumKeyEnc: true,
				payosConnectedAt: true
			},
			with: {
				user: {
					columns: { name: true, email: true, phone: true }
				}
			}
		});

		if (!landlordProfile) {
			return json({ error: 'Landlord profile not found' }, { status: 404 });
		}

		return json(toSettingsDto(landlordProfile));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const body = await request.json();
		const input = pickSettingsWriteInput(body as Record<string, unknown>);

		const updateData: Record<string, unknown> = {};
		if (input.companyName !== undefined) updateData.companyName = input.companyName;
		if (input.bankName !== undefined) updateData.bankName = input.bankName;
		if (input.bankCode !== undefined) updateData.bankCode = input.bankCode;
		if (input.accountNumber !== undefined) updateData.accountNumber = input.accountNumber;
		if (input.accountName !== undefined)
			updateData.accountName = String(input.accountName).toUpperCase();
		if (input.bankBranch !== undefined) updateData.bankBranch = input.bankBranch;
		if (input.momoNumber !== undefined) updateData.momoNumber = input.momoNumber || null;
		if (input.payosClientId !== undefined) updateData.payosClientId = input.payosClientId || null;
		if (input.payosApiKey !== undefined && input.payosApiKey) {
			updateData.payosApiKeyEnc = encryptSecret(String(input.payosApiKey));
		}
		if (input.payosChecksumKey !== undefined && input.payosChecksumKey) {
			updateData.payosChecksumKeyEnc = encryptSecret(String(input.payosChecksumKey));
		}
		if (
			input.payosClientId !== undefined ||
			input.payosApiKey !== undefined ||
			input.payosChecksumKey !== undefined
		) {
			updateData.payosConnectedAt = new Date();
		}

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		await db.update(landlordProfiles).set(updateData).where(eq(landlordProfiles.id, landlordId));

		if (
			input.bankName !== undefined ||
			input.bankCode !== undefined ||
			input.accountNumber !== undefined ||
			input.accountName !== undefined ||
			input.bankBranch !== undefined ||
			input.momoNumber !== undefined
		) {
			const account = await ensureDefaultPaymentAccount(landlordId);
			await db
				.update(paymentAccounts)
				.set({
					...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
					...(input.bankCode !== undefined ? { bankCode: input.bankCode } : {}),
					...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
					...(input.accountName !== undefined
						? { accountName: String(input.accountName).toUpperCase() }
						: {}),
					...(input.bankBranch !== undefined ? { bankBranch: input.bankBranch } : {}),
					...(input.momoNumber !== undefined ? { momoNumber: input.momoNumber || null } : {})
				})
				.where(eq(paymentAccounts.id, account.id));
		}

		const refreshed = await db.query.landlordProfiles.findFirst({
			where: eq(landlordProfiles.id, landlordId),
			columns: {
				id: true,
				companyName: true,
				bankName: true,
				bankCode: true,
				accountNumber: true,
				accountName: true,
				bankBranch: true,
				momoNumber: true,
				payosClientId: true,
				payosApiKeyEnc: true,
				payosChecksumKeyEnc: true,
				payosConnectedAt: true
			},
			with: {
				user: {
					columns: { name: true, email: true, phone: true }
				}
			}
		});
		if (!refreshed) {
			return json({ error: 'Landlord profile not found' }, { status: 404 });
		}

		return json(toSettingsDto(refreshed));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
