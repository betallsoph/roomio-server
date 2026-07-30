import { and, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import { invoices, paymentTransactions } from '$lib/server/db/schema';
import type { LandlordActor, TenantActor } from '$lib/server/authorization/actor';
import { listClaimedTenancyScopesForTenant } from './active-tenancy.js';
import type { TenancySnapshot } from './finance-scope.js';

type PaymentsDb = Pick<typeof AppDb, 'query' | 'select'>;

export type PaymentListFilters = {
	status?: string | null;
};

const PAYMENT_TRANSACTION_COLUMNS = {
	id: true,
	landlordId: true,
	invoiceId: true,
	paymentAccountId: true,
	provider: true,
	providerTransactionId: true,
	invoiceCode: true,
	amount: true,
	transferType: true,
	content: true,
	status: true,
	receivedAt: true
} as const;

const SAFE_PAYMENT_ACCOUNT_COLUMNS = {
	id: true,
	landlordId: true,
	name: true,
	provider: true,
	isDefault: true,
	isActive: true,
	bankName: true,
	bankCode: true,
	accountNumber: true,
	accountName: true,
	bankBranch: true,
	momoNumber: true,
	payosClientId: true,
	payosConnectedAt: true,
	createdAt: true,
	updatedAt: true
} as const;

const paymentWithRelations = {
	invoice: true,
	paymentAccount: { columns: SAFE_PAYMENT_ACCOUNT_COLUMNS }
} as const;

function invoiceSnapshotOrConditions(scopes: TenancySnapshot[]): SQL | undefined {
	if (scopes.length === 0) {
		return undefined;
	}
	const parts = scopes.map((scope) =>
		and(
			eq(invoices.managedTenantId, scope.managedTenantId),
			eq(invoices.tenancyId, scope.tenancyId)
		)
	);
	return or(...parts)!;
}

export async function listPaymentTransactionsForLandlord(
	database: PaymentsDb,
	actor: LandlordActor,
	filters: PaymentListFilters = {}
) {
	const conditions: SQL[] = [eq(paymentTransactions.landlordId, actor.landlordId)];
	if (filters.status) {
		conditions.push(eq(paymentTransactions.status, filters.status));
	}

	return database.query.paymentTransactions.findMany({
		columns: PAYMENT_TRANSACTION_COLUMNS,
		where: and(...conditions),
		with: paymentWithRelations,
		orderBy: desc(paymentTransactions.receivedAt),
		limit: 200
	});
}

export async function listPaymentTransactionsForTenant(
	database: PaymentsDb,
	actor: TenantActor,
	filters: PaymentListFilters = {}
) {
	const scopes = await listClaimedTenancyScopesForTenant(database, actor);
	const snapshotWhere = invoiceSnapshotOrConditions(
		scopes.map((scope) => ({
			managedTenantId: scope.managedTenantId,
			tenancyId: scope.tenancyId
		}))
	);
	if (!snapshotWhere) {
		return [];
	}

	const scopedInvoiceIds = database.select({ id: invoices.id }).from(invoices).where(snapshotWhere);

	const conditions: SQL[] = [inArray(paymentTransactions.invoiceId, scopedInvoiceIds)];
	if (filters.status) {
		conditions.push(eq(paymentTransactions.status, filters.status));
	}

	return database.query.paymentTransactions.findMany({
		columns: PAYMENT_TRANSACTION_COLUMNS,
		where: and(...conditions),
		with: paymentWithRelations,
		orderBy: desc(paymentTransactions.receivedAt),
		limit: 200
	});
}
