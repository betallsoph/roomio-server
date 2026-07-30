import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { LandlordActor, SuperAdminActor, TenantActor } from '../authorization/actor.js';
import {
	expectForeignResourceHidden,
	expectNoForbiddenKeys,
	findForbiddenKeys
} from '../authorization/security-assertions.js';
import {
	automationJobs,
	expenses,
	managedTenants,
	subscriptionChangeRequests,
	tenancies
} from '../db/schema.js';
import { SUPER_ADMIN_FORBIDDEN_KEYS } from '../dto/super-admin.js';
import {
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

const LANDLORD_A_REVENUE = 1_111_111;
const LANDLORD_B_REVENUE = 8_888_888;

type Auth015Extensions = {
	managedTenantANow: string;
	tenancyANowActive: string;
	pendingSubscriptionRequestA: string;
};

async function seedAuth015Extensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<Auth015Extensions> {
	const { ids } = fixture;
	const db = handle.db;
	const managedTenantANow = crypto.randomUUID();
	const tenancyANowActive = crypto.randomUUID();
	const pendingSubscriptionRequestA = crypto.randomUUID();

	await db.insert(managedTenants).values({
		id: managedTenantANow,
		landlordId: ids.landlordA.landlordProfileId,
		displayName: 'AUTH-015 tenant A now',
		claimedByUserId: ids.tenantANow.userId,
		legacyTenantProfileId: ids.tenantANow.tenantProfileId,
		backfillSource: 'LEGACY_TENANT_PROFILE'
	});

	await db.insert(tenancies).values({
		id: tenancyANowActive,
		landlordId: ids.landlordA.landlordProfileId,
		propertyId: ids.propertyA1.propertyId,
		roomId: ids.roomA1R1.roomId,
		managedTenantId: managedTenantANow,
		status: 'ACTIVE',
		startDate: '2026-01-01',
		plannedEndDate: '2026-12-31'
	});

	await db.insert(subscriptionChangeRequests).values({
		id: pendingSubscriptionRequestA,
		landlordId: ids.landlordA.landlordProfileId,
		requestedTier: 'ROOMS_4_10',
		requestedPeriod: 'MONTHLY',
		currentTier: 'FREE',
		currentPeriod: 'MONTHLY',
		standardRoomCount: 3,
		colivingRoomCount: 0,
		quotedMonthlyPrice: 100_000,
		quotedPeriodPrice: 100_000,
		pricingStrategy: 'fixture',
		status: 'pending'
	});

	return { managedTenantANow, tenancyANowActive, pendingSubscriptionRequestA };
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

function landlordActor(
	fixture: SecurityFixtureMap,
	which: 'landlordA' | 'landlordB'
): LandlordActor {
	const row = fixture.ids[which];
	return {
		kind: 'USER',
		userId: row.userId,
		role: 'LANDLORD',
		landlordId: row.landlordProfileId
	};
}

function tenantActor(fixture: SecurityFixtureMap, which: 'tenantANow' | 'tenantBNow'): TenantActor {
	const row = fixture.ids[which];
	return {
		kind: 'USER',
		userId: row.userId,
		role: 'TENANT',
		tenantProfileId: row.tenantProfileId
	};
}

function superAdminActor(fixture: SecurityFixtureMap): SuperAdminActor {
	return {
		kind: 'USER',
		userId: fixture.ids.superAdmin.userId,
		role: 'SUPER_ADMIN'
	};
}

if (skipReason) {
	test('AUTH-015 aggregate/settings security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-015 aggregate and settings route security', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ext = await seedAuth015Extensions(handle, fixture);
			const ids = fixture.ids;

			const { GET: getDashboardStats } =
				await import('../../../routes/api/dashboard/stats/+server.js');
			const { GET: getFinance } = await import('../../../routes/api/finance/+server.js');
			const { GET: getExpenses, POST: postExpenses } =
				await import('../../../routes/api/expenses/+server.js');
			const { GET: getSettings, PUT: putSettings } =
				await import('../../../routes/api/settings/+server.js');
			const { GET: getSupportContacts } =
				await import('../../../routes/api/support-contacts/+server.js');
			const { POST: postAutomation } = await import('../../../routes/api/automation/+server.js');
			const { PUT: putSubscriptionRequests } =
				await import('../../../routes/api/subscription/requests/+server.js');
			const { GET: getSuperAdmin } = await import('../../../routes/api/super-admin/+server.js');

			const landlordA = landlordActor(fixture, 'landlordA');
			const landlordB = landlordActor(fixture, 'landlordB');
			const tenantANow = tenantActor(fixture, 'tenantANow');
			const superAdmin = superAdminActor(fixture);

			await t.test('dashboard and finance aggregates are landlord-scoped', async () => {
				const dashA = await readJson(
					await callHandler(getDashboardStats, { locals: { actor: landlordA } })
				);
				assert.equal(dashA.status, 200);
				expectNoForbiddenKeys(dashA.body);
				assert.equal((dashA.body as { totalRevenue: number }).totalRevenue, LANDLORD_A_REVENUE);

				const dashB = await readJson(
					await callHandler(getDashboardStats, { locals: { actor: landlordB } })
				);
				assert.equal(dashB.status, 200);
				assert.equal((dashB.body as { totalRevenue: number }).totalRevenue, LANDLORD_B_REVENUE);
				assert.notEqual(
					(dashA.body as { totalRevenue: number }).totalRevenue,
					(dashB.body as { totalRevenue: number }).totalRevenue
				);

				const financeA = await readJson(
					await callHandler(getFinance, {
						url: new URL('http://localhost/api/finance?months=6'),
						locals: { actor: landlordA }
					})
				);
				assert.equal(financeA.status, 200);
				expectNoForbiddenKeys(financeA.body);
				const financeB = await readJson(
					await callHandler(getFinance, {
						url: new URL('http://localhost/api/finance?months=6'),
						locals: { actor: landlordB }
					})
				);
				assert.equal(financeB.status, 200);
				assert.notEqual(
					(financeA.body as { totalRevenue: number }).totalRevenue,
					(financeB.body as { totalRevenue: number }).totalRevenue
				);
			});

			await t.test(
				'expense optional property must be own landlord; null is common expense',
				async () => {
					const listA = await readJson(
						await callHandler(getExpenses, {
							url: new URL('http://localhost/api/expenses'),
							locals: { actor: landlordA }
						})
					);
					assert.equal(listA.status, 200);
					const expenseIds = (listA.body as Array<{ id: string }>).map((row) => row.id);
					assert.ok(expenseIds.includes(ids.expenseA.expenseId));
					assert.ok(expenseIds.includes(ids.expenseACommon.expenseId));
					assert.ok(!expenseIds.includes(ids.expenseB.expenseId));
					expectNoForbiddenKeys(listA.body);

					const foreignProperty = await readJson(
						await callHandler(postExpenses, {
							request: {
								json: async () => ({
									propertyId: ids.propertyB1.propertyId,
									category: 'maintenance',
									description: 'Cross-landlord expense',
									amount: 1000,
									date: '2026-06-21'
								})
							},
							locals: { actor: landlordA }
						})
					);
					assert.equal(foreignProperty.status, 404);

					const commonExpense = await readJson(
						await callHandler(postExpenses, {
							request: {
								json: async () => ({
									category: 'other',
									description: 'Common expense',
									amount: 50_000,
									date: '2026-06-22'
								})
							},
							locals: { actor: landlordA }
						})
					);
					assert.equal(commonExpense.status, 200);
					assert.equal((commonExpense.body as { propertyId: string | null }).propertyId, null);
				}
			);

			await t.test(
				'settings allowlist blocks mass assignment and never echoes credentials',
				async () => {
					const getRes = await readJson(
						await callHandler(getSettings, { locals: { actor: landlordA } })
					);
					assert.equal(getRes.status, 200);
					expectNoForbiddenKeys(getRes.body);
					assert.equal('payosApiKeyEnc' in (getRes.body as object), false);
					assert.equal('payosChecksumKeyEnc' in (getRes.body as object), false);
					assert.equal((getRes.body as { payosConnected: boolean }).payosConnected, true);

					const putRes = await readJson(
						await callHandler(putSettings, {
							request: {
								json: async () => ({
									companyName: 'AUTH-015 Updated Co',
									landlordId: ids.landlordB.landlordProfileId,
									role: 'SUPER_ADMIN',
									payosApiKeyEnc: 'stolen'
								})
							},
							locals: { actor: landlordA }
						})
					);
					assert.equal(putRes.status, 200);
					expectNoForbiddenKeys(putRes.body);
					assert.equal((putRes.body as { companyName: string }).companyName, 'AUTH-015 Updated Co');
					assert.equal('payosApiKeyEnc' in (putRes.body as object), false);
				}
			);

			await t.test(
				'tenant support contacts are read-only from own landlord shareable fields',
				async () => {
					const tenantRes = await readJson(
						await callHandler(getSupportContacts, { locals: { actor: tenantANow } })
					);
					assert.equal(tenantRes.status, 200);
					const contacts = tenantRes.body as Array<Record<string, unknown>>;
					assert.ok(contacts.some((row) => row.id === ids.supportContactA.supportContactId));
					assert.ok(!contacts.some((row) => row.id === ids.supportContactB.supportContactId));
					for (const row of contacts) {
						assert.equal('landlordId' in row, false);
						assert.equal('notes' in row, false);
						assert.equal('isActive' in row, false);
					}
					expectNoForbiddenKeys(tenantRes.body);

					const tenantBRes = await readJson(
						await callHandler(getSupportContacts, {
							locals: { actor: tenantActor(fixture, 'tenantBNow') }
						})
					);
					assert.equal(tenantBRes.status, 200);
					const tenantBContacts = tenantBRes.body as Array<{ id: string }>;
					assert.ok(tenantBContacts.some((row) => row.id === ids.supportContactB.supportContactId));
					assert.ok(
						!tenantBContacts.some((row) => row.id === ids.supportContactA.supportContactId)
					);
				}
			);

			await t.test('automation jobs server-attach landlord; payload cannot override', async () => {
				const res = await readJson(
					await callHandler(postAutomation, {
						request: {
							json: async () => ({
								action: 'overdue_sweep',
								landlordId: ids.landlordB.landlordProfileId
							})
						},
						locals: { actor: landlordA }
					})
				);
				assert.equal(res.status, 200);

				const jobs = await handle.db
					.select({ landlordId: automationJobs.landlordId })
					.from(automationJobs)
					.where(eq(automationJobs.landlordId, ids.landlordA.landlordProfileId))
					.orderBy(automationJobs.createdAt);
				assert.ok(jobs.length > 0);
				assert.ok(jobs.every((job) => job.landlordId === ids.landlordA.landlordProfileId));
			});

			await t.test(
				'landlord cannot self-approve subscription; super admin review path is separate',
				async () => {
					const selfApprove = await readJson(
						await callHandler(putSubscriptionRequests, {
							request: {
								json: async () => ({
									id: ext.pendingSubscriptionRequestA,
									action: 'approve'
								})
							},
							locals: { actor: landlordA }
						})
					);
					assert.equal(selfApprove.status, 403);

					const adminReject = await readJson(
						await callHandler(putSubscriptionRequests, {
							request: {
								json: async () => ({
									id: ext.pendingSubscriptionRequestA,
									action: 'reject',
									adminNote: 'AUTH-015 review'
								})
							},
							locals: { actor: superAdmin }
						})
					);
					assert.equal(adminReject.status, 200);
					assert.equal((adminReject.body as { status: string }).status, 'rejected');
				}
			);

			await t.test('super admin DTO excludes operational nested relations', async () => {
				const res = await readJson(
					await callHandler(getSuperAdmin, { locals: { actor: superAdmin } })
				);
				assert.equal(res.status, 200);
				expectNoForbiddenKeys(res.body);

				const hits = findForbiddenKeys(res.body).filter((hit) =>
					SUPER_ADMIN_FORBIDDEN_KEYS.includes(
						hit.key as (typeof SUPER_ADMIN_FORBIDDEN_KEYS)[number]
					)
				);
				assert.equal(hits.length, 0);

				const landlords = res.body as Array<{ properties: Array<Record<string, unknown>> }>;
				for (const landlord of landlords) {
					for (const property of landlord.properties) {
						assert.equal('rooms' in property, false);
						assert.equal('invoices' in property, false);
					}
				}
			});

			await t.test('landlord B cannot read landlord A expense by id mutation', async () => {
				const before = await handle.db.query.expenses.findFirst({
					where: eq(expenses.id, ids.expenseA.expenseId),
					columns: { description: true }
				});
				const { PUT: putExpenses } = await import('../../../routes/api/expenses/+server.js');
				const denied = await readJson(
					await callHandler(putExpenses, {
						request: {
							json: async () => ({
								id: ids.expenseA.expenseId,
								description: 'Hijacked'
							})
						},
						locals: { actor: landlordB }
					})
				);
				await expectForeignResourceHidden(
					new Response(JSON.stringify(denied.body), { status: denied.status }),
					{ status: 404, sensitiveIds: [ids.expenseA.expenseId] }
				);
				const after = await handle.db.query.expenses.findFirst({
					where: eq(expenses.id, ids.expenseA.expenseId),
					columns: { description: true }
				});
				assert.equal(after?.description, before?.description);
			});
		});
	});
}
