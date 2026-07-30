import { json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { paymentAccounts } from '$lib/server/db/schema';
import { requireLandlordActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import {
	findPaymentAccountForLandlord,
	ScopedResourceNotFoundError
} from '$lib/server/authorization/scoped-queries';
import { toPaymentAccountDto } from '$lib/server/dto/payment-account';
import {
	ensureDefaultPaymentAccount,
	getPaymentAccountForLandlord,
	listPaymentAccounts,
	setDefaultPaymentAccount
} from '$lib/server/payment-accounts';
import { encryptSecret } from '$lib/server/secrets';
import { confirmPayOSWebhook, getPayosWebhookUrl } from '$lib/server/payos';

function mapHandlerError(error: unknown) {
	if (error instanceof ScopedResourceNotFoundError) {
		return json({ error: error.message }, { status: 404 });
	}
	if (isAuthorizationError(error)) {
		return authorizationErrorToResponse(error);
	}
	return json({ error: errorMessage(error) }, { status: 500 });
}

function cleanString(value: unknown) {
	return String(value ?? '').trim();
}

function cleanProvider(value: unknown) {
	return cleanString(value).toLowerCase() === 'payos' ? 'payos' : 'vietqr';
}

async function confirmWebhookIfPayOS(input: {
	provider: string;
	clientId: string;
	apiKey: string;
	checksumKey: string;
}) {
	if (input.provider !== 'payos' || !input.clientId || !input.apiKey || !input.checksumKey) {
		return { webhookRegistered: false, warning: null as string | null };
	}
	try {
		await confirmPayOSWebhook(
			{ clientId: input.clientId, apiKey: input.apiKey, checksumKey: input.checksumKey },
			getPayosWebhookUrl()
		);
		return { webhookRegistered: true, warning: null };
	} catch (error) {
		return { webhookRegistered: false, warning: errorMessage(error) };
	}
}

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(
				wrongRoleError('Không có quyền quản lý tài khoản nhận tiền')
			);
		}

		const accounts = await listPaymentAccounts(landlord.value.landlordId);
		return json({ accounts: accounts.map(toPaymentAccountDto) });
	} catch (error) {
		return mapHandlerError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(
				wrongRoleError('Không có quyền quản lý tài khoản nhận tiền')
			);
		}

		const body = await request.json();
		const landlordId = landlord.value.landlordId;
		const provider = cleanProvider(body.provider);
		const name = cleanString(body.name);
		const bankName = cleanString(body.bankName);
		const bankCode = cleanString(body.bankCode);
		const accountNumber = cleanString(body.accountNumber);
		const accountName = cleanString(body.accountName);
		const clientId = cleanString(body.clientId);
		const apiKey = cleanString(body.apiKey);
		const checksumKey = cleanString(body.checksumKey);
		const isDefault = !!body.isDefault;

		if (!name || !bankName || !bankCode || !accountNumber || !accountName) {
			return json(
				{ error: 'Cần đủ tên kênh, ngân hàng, số tài khoản và chủ tài khoản' },
				{ status: 400 }
			);
		}
		if (provider === 'payos' && (!clientId || !apiKey || !checksumKey)) {
			return json(
				{ error: 'Tài khoản PayOS cần đủ clientId, apiKey và checksumKey' },
				{ status: 400 }
			);
		}

		const webhook = await confirmWebhookIfPayOS({ provider, clientId, apiKey, checksumKey });

		const account = await db.transaction(async (tx) => {
			const existing = await tx
				.select({ id: paymentAccounts.id })
				.from(paymentAccounts)
				.where(and(eq(paymentAccounts.landlordId, landlordId), eq(paymentAccounts.isActive, true)));
			const shouldDefault = isDefault || existing.length === 0;
			if (shouldDefault) {
				await tx
					.update(paymentAccounts)
					.set({ isDefault: false })
					.where(eq(paymentAccounts.landlordId, landlordId));
			}

			const created = await tx
				.insert(paymentAccounts)
				.values({
					landlordId,
					name,
					provider,
					isDefault: shouldDefault,
					isActive: true,
					bankName,
					bankCode,
					accountNumber,
					accountName,
					bankBranch: cleanString(body.bankBranch) || null,
					momoNumber: cleanString(body.momoNumber) || null,
					payosClientId: provider === 'payos' ? clientId : null,
					payosApiKeyEnc: provider === 'payos' ? encryptSecret(apiKey) : null,
					payosChecksumKeyEnc: provider === 'payos' ? encryptSecret(checksumKey) : null,
					payosConnectedAt: provider === 'payos' ? new Date() : null
				})
				.returning();
			return created[0];
		});

		return json(
			{
				account: toPaymentAccountDto(account),
				webhookRegistered: webhook.webhookRegistered,
				webhookUrl: getPayosWebhookUrl(),
				warning: webhook.warning
			},
			{ status: 201 }
		);
	} catch (error) {
		return mapHandlerError(error);
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(
				wrongRoleError('Không có quyền quản lý tài khoản nhận tiền')
			);
		}

		const body = await request.json();
		const landlordId = landlord.value.landlordId;
		const id = cleanString(body.id);
		if (!id) return json({ error: 'Thiếu tài khoản nhận tiền' }, { status: 400 });

		await findPaymentAccountForLandlord(db, landlord.value, id);
		const current = await getPaymentAccountForLandlord(landlordId, id);

		if (body.isDefault === true) {
			const account = await setDefaultPaymentAccount(landlordId, id);
			return json({
				account: toPaymentAccountDto(account),
				webhookRegistered: false,
				warning: null
			});
		}

		const provider = body.provider !== undefined ? cleanProvider(body.provider) : current.provider;
		const clientId =
			body.clientId !== undefined ? cleanString(body.clientId) : (current.payosClientId ?? '');
		const apiKey = cleanString(body.apiKey);
		const checksumKey = cleanString(body.checksumKey);
		if (
			provider === 'payos' &&
			(!clientId ||
				(!apiKey && !current.payosApiKeyEnc) ||
				(!checksumKey && !current.payosChecksumKeyEnc))
		) {
			return json(
				{ error: 'Tài khoản PayOS cần đủ clientId, apiKey và checksumKey' },
				{ status: 400 }
			);
		}

		const webhook = await confirmWebhookIfPayOS({ provider, clientId, apiKey, checksumKey });
		const updateData: Partial<typeof paymentAccounts.$inferInsert> = {};
		if (body.name !== undefined) updateData.name = cleanString(body.name);
		if (body.provider !== undefined) updateData.provider = provider;
		if (body.bankName !== undefined) updateData.bankName = cleanString(body.bankName);
		if (body.bankCode !== undefined) updateData.bankCode = cleanString(body.bankCode);
		if (body.accountNumber !== undefined)
			updateData.accountNumber = cleanString(body.accountNumber);
		if (body.accountName !== undefined) updateData.accountName = cleanString(body.accountName);
		if (body.bankBranch !== undefined) updateData.bankBranch = cleanString(body.bankBranch) || null;
		if (body.momoNumber !== undefined) updateData.momoNumber = cleanString(body.momoNumber) || null;
		if (body.isActive !== undefined) updateData.isActive = !!body.isActive;
		if (provider === 'vietqr') {
			updateData.payosClientId = null;
			updateData.payosApiKeyEnc = null;
			updateData.payosChecksumKeyEnc = null;
			updateData.payosConnectedAt = null;
		} else if (body.clientId !== undefined || apiKey || checksumKey) {
			updateData.payosClientId = clientId;
			if (apiKey) updateData.payosApiKeyEnc = encryptSecret(apiKey);
			if (checksumKey) updateData.payosChecksumKeyEnc = encryptSecret(checksumKey);
			updateData.payosConnectedAt = new Date();
		}

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'Không có thông tin cần cập nhật' }, { status: 400 });
		}

		const updated = await db
			.update(paymentAccounts)
			.set(updateData)
			.where(and(eq(paymentAccounts.id, id), eq(paymentAccounts.landlordId, landlordId)))
			.returning();

		return json({
			account: toPaymentAccountDto(updated[0]),
			webhookRegistered: webhook.webhookRegistered,
			webhookUrl: getPayosWebhookUrl(),
			warning: webhook.warning
		});
	} catch (error) {
		return mapHandlerError(error);
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(
				wrongRoleError('Không có quyền quản lý tài khoản nhận tiền')
			);
		}

		const landlordId = landlord.value.landlordId;
		const id = cleanString(url.searchParams.get('id'));
		if (!id) return json({ error: 'Thiếu tài khoản nhận tiền' }, { status: 400 });

		const account = await getPaymentAccountForLandlord(landlordId, id);
		await findPaymentAccountForLandlord(db, landlord.value, id);

		const activeAccounts = await listPaymentAccounts(landlordId);
		if (activeAccounts.length <= 1) {
			return json({ error: 'Cần giữ ít nhất một tài khoản nhận tiền' }, { status: 400 });
		}

		await db.transaction(async (tx) => {
			await tx
				.update(paymentAccounts)
				.set({ isActive: false, isDefault: false })
				.where(and(eq(paymentAccounts.id, id), eq(paymentAccounts.landlordId, landlordId)));
			if (account.isDefault) {
				const replacement = activeAccounts.find((item) => item.id !== id);
				if (replacement) {
					await tx
						.update(paymentAccounts)
						.set({ isDefault: true })
						.where(eq(paymentAccounts.id, replacement.id));
				}
			}
		});

		await ensureDefaultPaymentAccount(landlordId);
		return json({ success: true });
	} catch (error) {
		return mapHandlerError(error);
	}
};
