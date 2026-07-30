import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { invoices, managedTenants, paymentTransactions, tenancies } from '../db/schema.js';
import type { LandlordActor, TenantActor } from '../authorization/actor.js';
import { createDrizzleActorDb, getUserActor } from '../authorization/load-user-actor.js';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import {
	fixtureSession,
	seedSecurityFixturesFromHandle,
	type SecurityFixtureMap
} from '../testing/security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb,
	type SecurityDbHandle
} from '../testing/test-db.js';

const skipReason = getSecurityIntegrationSkipReason();

type Auth012Extension = {
	managedTenantANow: string;
	managedTenantAOld: string;
	tenancyANowActive: string;
	tenancyAOldEnded: string;
	paymentTxnANow: string;
	paymentTxnAOld: string;
	paymentTxnBNow: string;
};

async function seedAuth012Extensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<Auth012Extension> {
	const { ids } = fixture;
	const db = handle.db;

	const managedTenantANow = crypto.randomUUID();
	const managedTenantAOld = crypto.randomUUID();
	const tenancyANowActive = crypto.randomUUID();
	const tenancyAOldEnded = crypto.randomUUID();
	const paymentTxnANow = crypto.randomUUID();
	const paymentTxnAOld = crypto.randomUUID();
	const paymentTxnBNow = crypto.randomUUID();

	await db.insert(managedTenants).values([
		{
			id: managedTenantANow,
			landlordId: ids.landlordA.landlordProfileId,
			displayName: 'AUTH-012 managed tenant now',
			claimedByUserId: ids.tenantANow.userId,
			legacyTenantProfileId: ids.tenantANow.tenantProfileId,
			backfillSource: 'LEGACY_TENANT_PROFILE'
		},
		{
			id: managedTenantAOld,
			landlordId: ids.landlordA.landlordProfileId,
			displayName: 'AUTH-012 managed tenant old',
			claimedByUserId: ids.tenantAOld.userId,
			legacyTenantProfileId: ids.tenantAOld.tenantProfileId,
			backfillSource: 'LEGACY_TENANT_PROFILE'
		}
	]);

	await db.insert(tenancies).values([
		{
			id: tenancyANowActive,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			roomId: ids.roomA1R1.roomId,
			managedTenantId: managedTenantANow,
			status: 'ACTIVE',
			startDate: '2026-01-01'
		},
		{
			id: tenancyAOldEnded,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			roomId: ids.roomA1R1.roomId,
			managedTenantId: managedTenantAOld,
			status: 'ENDED',
			startDate: '2025-01-01',
			endDate: '2025-12-31'
		}
	]);

	await db
		.update(invoices)
		.set({
			managedTenantId: managedTenantANow,
			tenancyId: tenancyANowActive
		})
		.where(eq(invoices.id, ids.invoiceANow.invoiceId));

	await db
		.update(invoices)
		.set({
			managedTenantId: managedTenantAOld,
			tenancyId: tenancyAOldEnded
		})
		.where(eq(invoices.id, ids.invoiceAOld.invoiceId));

	await db
		.update(invoices)
		.set({
			managedTenantId: managedTenantANow,
			tenancyId: tenancyANowActive
		})
		.where(eq(invoices.id, ids.invoiceA2Now.invoiceId));

	await db.insert(paymentTransactions).values([
		{
			id: paymentTxnANow,
			landlordId: ids.landlordA.landlordProfileId,
			invoiceId: ids.invoiceANow.invoiceId,
			paymentAccountId: ids.paymentAccountA.paymentAccountId,
			provider: 'payos',
			providerTransactionId: 'auth012-txn-a-now',
			amount: 3_820_000,
			transferType: 'bank',
			status: 'applied',
			rawPayload: '{"secret":true,"nested":{"payosApiKeyEnc":"leak"}}'
		},
		{
			id: paymentTxnAOld,
			landlordId: ids.landlordA.landlordProfileId,
			invoiceId: ids.invoiceAOld.invoiceId,
			paymentAccountId: ids.paymentAccountA.paymentAccountId,
			provider: 'payos',
			providerTransactionId: 'auth012-txn-a-old',
			amount: 3_450_000,
			transferType: 'bank',
			status: 'applied',
			rawPayload: '{"legacy":true}'
		},
		{
			id: paymentTxnBNow,
			landlordId: ids.landlordB.landlordProfileId,
			invoiceId: ids.invoiceBNow.invoiceId,
			paymentAccountId: ids.paymentAccountB.paymentAccountId,
			provider: 'payos',
			providerTransactionId: 'auth012-txn-b-now',
			amount: 3_000_000,
			transferType: 'bank',
			status: 'applied',
			rawPayload: '{"foreign":true}'
		}
	]);

	return {
		managedTenantANow,
		managedTenantAOld,
		tenancyANowActive,
		tenancyAOldEnded,
		paymentTxnANow,
		paymentTxnAOld,
		paymentTxnBNow
	};
}

async function actorFromSession(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap,
	who: Parameters<typeof fixtureSession>[1]
) {
	return getUserActor(fixtureSession(fixture, who), createDrizzleActorDb(handle.db));
}

async function callHandler(handler: unknown, event: Record<string, unknown>): Promise<Response> {
	return (handler as (e: unknown) => Promise<Response>)(event);
}

async function readJson(response: Response): Promise<{ status: number; body: unknown }> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	return { status: response.status, body };
}

if (skipReason) {
	test('AUTH-012 payments security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-012 payments security suite', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ext = await seedAuth012Extensions(handle, fixture);
			const ids = fixture.ids;

			const { GET: getPayments } = await import('../../../routes/api/payments/+server.js');
			const { GET: getPaymentAccounts } =
				await import('../../../routes/api/payment-accounts/+server.js');

			const landlordA = (await actorFromSession(handle, fixture, 'landlordA')) as LandlordActor;
			const landlordB = (await actorFromSession(handle, fixture, 'landlordB')) as LandlordActor;
			const tenantANow = (await actorFromSession(handle, fixture, 'tenantANow')) as TenantActor;
			const tenantAOld = (await actorFromSession(handle, fixture, 'tenantAOld')) as TenantActor;

			async function paymentsGet(actor: LandlordActor | TenantActor) {
				const url = new URL('http://localhost/api/payments');
				return readJson(await callHandler(getPayments, { url, locals: { actor } }));
			}

			async function paymentAccountsGet(actor: LandlordActor) {
				const url = new URL('http://localhost/api/payment-accounts');
				return readJson(await callHandler(getPaymentAccounts, { url, locals: { actor } }));
			}

			await t.test('landlordA payment list excludes landlordB transactions', async () => {
				const result = await paymentsGet(landlordA);
				assert.equal(result.status, 200);
				const txnIds = (result.body as Array<{ id: string }>).map((row) => row.id);
				assert.ok(txnIds.includes(ext.paymentTxnANow));
				assert.ok(txnIds.includes(ext.paymentTxnAOld));
				assert.ok(!txnIds.includes(ext.paymentTxnBNow));
				expectNoForbiddenKeys(result.body);
			});

			await t.test('tenant now sees only claimed tenancy payment history', async () => {
				const result = await paymentsGet(tenantANow);
				assert.equal(result.status, 200);
				const txnIds = (result.body as Array<{ id: string }>).map((row) => row.id);
				assert.ok(txnIds.includes(ext.paymentTxnANow));
				assert.ok(!txnIds.includes(ext.paymentTxnAOld));
				assert.ok(!txnIds.includes(ext.paymentTxnBNow));
				expectNoForbiddenKeys(result.body);
			});

			await t.test('old tenant sees ended tenancy payments only', async () => {
				const result = await paymentsGet(tenantAOld);
				assert.equal(result.status, 200);
				const txnIds = (result.body as Array<{ id: string }>).map((row) => row.id);
				assert.ok(txnIds.includes(ext.paymentTxnAOld));
				assert.ok(!txnIds.includes(ext.paymentTxnANow));
				expectNoForbiddenKeys(result.body);
			});

			await t.test('landlordA payment accounts exclude landlordB accounts', async () => {
				const result = await paymentAccountsGet(landlordA);
				assert.equal(result.status, 200);
				const accounts = (result.body as { accounts: Array<{ id: string; landlordId: string }> })
					.accounts;
				const accountIds = accounts.map((row) => row.id);
				assert.ok(accountIds.includes(ids.paymentAccountA.paymentAccountId));
				assert.ok(!accountIds.includes(ids.paymentAccountB.paymentAccountId));
				for (const account of accounts) {
					assert.equal(account.landlordId, ids.landlordA.landlordProfileId);
				}
				expectNoForbiddenKeys(result.body);
			});

			await t.test('landlordB cannot read landlordA payment accounts', async () => {
				const result = await paymentAccountsGet(landlordB);
				assert.equal(result.status, 200);
				const accountIds = (
					(result.body as { accounts: Array<{ id: string }> }).accounts ?? []
				).map((row) => row.id);
				assert.ok(!accountIds.includes(ids.paymentAccountA.paymentAccountId));
				assert.ok(accountIds.includes(ids.paymentAccountB.paymentAccountId));
			});
		});
	});
}
