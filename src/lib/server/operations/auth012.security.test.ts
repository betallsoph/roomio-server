import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { invoices, managedTenants, tenancies } from '../db/schema.js';
import type { LandlordActor, TenantActor } from '../authorization/actor.js';
import { createDrizzleActorDb, getUserActor } from '../authorization/load-user-actor.js';
import {
	expectForeignResourceHidden,
	expectNoForbiddenKeys
} from '../authorization/security-assertions.js';
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
			startDate: '2026-01-01',
			plannedEndDate: '2026-12-31'
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
		.set({ managedTenantId: managedTenantAOld, tenancyId: tenancyAOldEnded })
		.where(eq(invoices.id, ids.invoiceAOld.invoiceId));
	await db
		.update(invoices)
		.set({ managedTenantId: managedTenantANow, tenancyId: tenancyANowActive })
		.where(eq(invoices.id, ids.invoiceANow.invoiceId));

	await db.execute(sql`
		UPDATE "PaymentAccount"
		SET "payosApiKeyEnc" = 'secret-api-key',
		    "payosChecksumKeyEnc" = 'secret-checksum'
		WHERE "id" = ${ids.paymentAccountA.paymentAccountId}
	`);

	return {
		managedTenantANow,
		managedTenantAOld,
		tenancyANowActive,
		tenancyAOldEnded
	};
}

async function actorFromSession(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap,
	who: Parameters<typeof fixtureSession>[1]
) {
	const actorDb = createDrizzleActorDb(handle.db);
	return getUserActor(fixtureSession(fixture, who), actorDb);
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
	test('AUTH-012 invoice scope security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('invoice routes do not import tenantOwnsInvoice', () => {
		const root = fileURLToPath(new URL('../../../../', import.meta.url));
		const paths = [
			'src/routes/api/invoices/+server.ts',
			'src/routes/api/invoices/[id]/+server.ts',
			'src/routes/api/invoices/[id]/payment-link/+server.ts'
		];
		for (const rel of paths) {
			const source = readFileSync(`${root}/${rel}`, 'utf8');
			assert.equal(
				source.includes('tenantOwnsInvoice'),
				false,
				`${rel} must not use Room.tenantId invoice authz`
			);
		}
	});

	test('AUTH-012 invoice scope security', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			await seedAuth012Extensions(handle, fixture);
			const ids = fixture.ids;

			const { GET: listInvoices } = await import('../../../routes/api/invoices/+server.js');
			const { GET: getInvoice } = await import('../../../routes/api/invoices/[id]/+server.js');
			const { POST: paymentLink } =
				await import('../../../routes/api/invoices/[id]/payment-link/+server.js');

			const landlordA = (await actorFromSession(handle, fixture, 'landlordA')) as LandlordActor;
			const landlordB = (await actorFromSession(handle, fixture, 'landlordB')) as LandlordActor;
			const tenantANow = (await actorFromSession(handle, fixture, 'tenantANow')) as TenantActor;

			async function listInvoiceIds(actor: LandlordActor | TenantActor) {
				const url = new URL('http://localhost/api/invoices');
				const res = await callHandler(listInvoices, { url, locals: { actor } });
				const parsed = await readJson(res);
				const body = parsed.body;
				return {
					status: parsed.status,
					ids: Array.isArray(body) ? body.map((row) => (row as { id: string }).id) : []
				};
			}

			await t.test('tenantANow cannot list predecessor invoice on reused room', async () => {
				const result = await listInvoiceIds(tenantANow);
				assert.equal(result.status, 200);
				assert.ok(result.ids.includes(ids.invoiceANow.invoiceId));
				assert.ok(!result.ids.includes(ids.invoiceAOld.invoiceId));
			});

			await t.test('tenantANow cannot GET old invoice by id', async () => {
				const res = await callHandler(getInvoice, {
					params: { id: ids.invoiceAOld.invoiceId },
					locals: { actor: tenantANow }
				});
				await expectForeignResourceHidden(res, {
					sensitiveIds: [ids.invoiceAOld.invoiceId],
					status: 404
				});
			});

			await t.test('landlordB cannot GET landlordA invoice', async () => {
				const res = await callHandler(getInvoice, {
					params: { id: ids.invoiceANow.invoiceId },
					locals: { actor: landlordB }
				});
				await expectForeignResourceHidden(res, {
					sensitiveIds: [ids.invoiceANow.invoiceId],
					status: 404
				});
			});

			await t.test('landlordA invoice list excludes landlordB invoices', async () => {
				const result = await listInvoiceIds(landlordA);
				assert.equal(result.status, 200);
				assert.ok(result.ids.includes(ids.invoiceANow.invoiceId));
				assert.ok(!result.ids.includes(ids.invoiceBNow.invoiceId));
			});

			await t.test('invoice list DTO passes forbidden-key scan', async () => {
				const url = new URL('http://localhost/api/invoices');
				const res = await callHandler(listInvoices, { url, locals: { actor: landlordA } });
				const parsed = await readJson(res);
				assert.equal(parsed.status, 200);
				expectNoForbiddenKeys(parsed.body);
			});

			await t.test('payment-link rejects cross-landlord payment account on invoice', async () => {
				await handle.db
					.update(invoices)
					.set({ paymentAccountId: ids.paymentAccountB.paymentAccountId })
					.where(eq(invoices.id, ids.invoiceANow.invoiceId));

				const res = await callHandler(paymentLink, {
					params: { id: ids.invoiceANow.invoiceId },
					locals: { actor: tenantANow }
				});
				assert.equal(res.status, 404);

				await handle.db
					.update(invoices)
					.set({ paymentAccountId: ids.paymentAccountA.paymentAccountId })
					.where(eq(invoices.id, ids.invoiceANow.invoiceId));
			});

			await t.test('landlord can still read legacy invoice without tenancy snapshot', async () => {
				const legacyId = `INV-LEGACY-${handle.runId.slice(-6)}`;
				await handle.db.insert(invoices).values({
					id: legacyId,
					roomId: ids.roomA1R1.roomId,
					roomNumber: 'A1-R1',
					tenantName: 'Legacy only',
					tenantPhone: '0900000099',
					month: '2024-01',
					rentAmount: 1_000_000,
					totalAmount: 1_000_000,
					dueDate: '2024-01-10',
					status: 'paid',
					paidAmount: 1_000_000,
					paymentAccountId: ids.paymentAccountA.paymentAccountId,
					createdAt: '2024-01-01',
					managedTenantId: null,
					tenancyId: null
				});

				const res = await callHandler(getInvoice, {
					params: { id: legacyId },
					locals: { actor: landlordA }
				});
				const parsed = await readJson(res);
				assert.equal(parsed.status, 200);
				expectNoForbiddenKeys(parsed.body);

				const tenantRes = await callHandler(getInvoice, {
					params: { id: legacyId },
					locals: { actor: tenantANow }
				});
				await expectForeignResourceHidden(tenantRes, { status: 404 });
			});
		});
	});
}
