import { eq } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { contracts } from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import {
	findPaymentAccountForLandlord,
	ScopedResourceNotFoundError
} from '$lib/server/authorization/scoped-queries';
import { assertContractOwnedByLandlord } from '$lib/server/operations/finance-scope';

type ContractDb = typeof AppDb;

export async function updateContractForLandlord(
	database: ContractDb,
	actor: LandlordActor,
	contractId: string,
	updateData: Record<string, unknown>
) {
	await assertContractOwnedByLandlord(database, actor, contractId);

	const updated = await database
		.update(contracts)
		.set(updateData)
		.where(eq(contracts.id, contractId))
		.returning();

	if (!updated[0]) {
		throw new ScopedResourceNotFoundError();
	}
	return updated[0];
}

export async function deleteContractForLandlord(
	database: ContractDb,
	actor: LandlordActor,
	contractId: string
) {
	await assertContractOwnedByLandlord(database, actor, contractId);

	const deleted = await database
		.delete(contracts)
		.where(eq(contracts.id, contractId))
		.returning({ id: contracts.id });

	if (!deleted[0]) {
		throw new ScopedResourceNotFoundError();
	}
}

export async function resolveContractPaymentAccount(
	database: ContractDb,
	actor: LandlordActor,
	paymentAccountId: string | null | undefined
): Promise<string> {
	if (!paymentAccountId) {
		throw new ScopedResourceNotFoundError('Tài khoản nhận tiền không hợp lệ');
	}
	const account = await findPaymentAccountForLandlord(database, actor, paymentAccountId);
	if (!account.isActive) {
		throw new Error('Tài khoản nhận tiền đã tắt');
	}
	return account.id;
}
