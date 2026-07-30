import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { LandlordActor } from '$lib/server/authorization/actor.js';
import { invoices, rooms } from '$lib/server/db/schema.js';
import {
	seedSecurityFixturesFromHandle,
	type SecurityFixtureMap
} from '$lib/server/testing/security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb,
	type SecurityDbHandle
} from '$lib/server/testing/test-db.js';
import { POST as postDraftApprove } from './+server.js';

const skipReason = getSecurityIntegrationSkipReason();

type DraftApproveExtensions = {
	draftA1: string;
	draftA2: string;
	draftB: string;
};

async function seedDraftApproveExtensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<DraftApproveExtensions> {
	const { ids } = fixture;
	const draftA1 = `INV-DRAFT-A1-${crypto.randomUUID().slice(0, 8)}`;
	const draftA2 = `INV-DRAFT-A2-${crypto.randomUUID().slice(0, 8)}`;
	const draftB = `INV-DRAFT-B-${crypto.randomUUID().slice(0, 8)}`;

	await handle.db.insert(invoices).values([
		{
			id: draftA1,
			roomId: ids.roomA1R1.roomId,
			roomNumber: 'A1-R1',
			tenantName: 'Tenant A Now',
			tenantPhone: '0900000001',
			month: '2026-07',
			rentAmount: 3_500_000,
			totalAmount: 3_500_000,
			dueDate: '2026-07-10',
			status: 'draft',
			paymentAccountId: ids.paymentAccountA.paymentAccountId,
			createdAt: '2026-07-01'
		},
		{
			id: draftA2,
			roomId: ids.roomA2R1.roomId,
			roomNumber: 'A2-R1',
			tenantName: 'Tenant A2 Now',
			tenantPhone: '0900000002',
			month: '2026-07',
			rentAmount: 4_000_000,
			totalAmount: 4_000_000,
			dueDate: '2026-07-10',
			status: 'draft',
			paymentAccountId: ids.paymentAccountA.paymentAccountId,
			createdAt: '2026-07-01'
		},
		{
			id: draftB,
			roomId: ids.roomB1R1.roomId,
			roomNumber: 'B1-R1',
			tenantName: 'Tenant B Now',
			tenantPhone: '0900000003',
			month: '2026-07',
			rentAmount: 2_800_000,
			totalAmount: 2_800_000,
			dueDate: '2026-07-10',
			status: 'draft',
			paymentAccountId: ids.paymentAccountB.paymentAccountId,
			createdAt: '2026-07-01'
		}
	]);

	return { draftA1, draftA2, draftB };
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

async function readJson(response: Response): Promise<{ status: number; body: unknown }> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	return { status: response.status, body };
}

(skipReason ? test.skip : test)(
	'AUTH-012 draft-approve — scoped query + conditional status',
	async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ext = await seedDraftApproveExtensions(handle, fixture);
			const { ids } = fixture;
			const landlordA = landlordActor(fixture, 'landlordA');

			await t.test('mixed own/foreign ids → 404', async () => {
				const res = await postDraftApprove({
					request: new Request('http://localhost/api/invoices/draft-approve', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ ids: [ext.draftA1, ext.draftB] })
					}),
					locals: { actor: landlordA }
				} as Parameters<typeof postDraftApprove>[0]);

				const result = await readJson(res);
				assert.equal(result.status, 404);

				const row = await handle.db.query.invoices.findFirst({
					where: eq(invoices.id, ext.draftA1),
					columns: { status: true }
				});
				assert.equal(row?.status, 'draft');
			});

			await t.test('foreign propertyId + month → 404', async () => {
				const res = await postDraftApprove({
					request: new Request('http://localhost/api/invoices/draft-approve', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							propertyId: ids.propertyB1.propertyId,
							month: '2026-07'
						})
					}),
					locals: { actor: landlordA }
				} as Parameters<typeof postDraftApprove>[0]);
				assert.equal(res.status, 404);
			});

			await t.test(
				'propertyId + month approves only landlord-owned drafts in property',
				async () => {
					const res = await readJson(
						await postDraftApprove({
							request: new Request('http://localhost/api/invoices/draft-approve', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({
									propertyId: ids.propertyA2.propertyId,
									month: '2026-07'
								})
							}),
							locals: { actor: landlordA }
						} as Parameters<typeof postDraftApprove>[0])
					);
					assert.equal(res.status, 200);
					assert.deepEqual((res.body as { count: number }).count, 1);

					const draftA2 = await handle.db.query.invoices.findFirst({
						where: eq(invoices.id, ext.draftA2),
						columns: { status: true }
					});
					assert.equal(draftA2?.status, 'pending');

					const draftB = await handle.db.query.invoices.findFirst({
						where: eq(invoices.id, ext.draftB),
						columns: { status: true }
					});
					assert.equal(draftB?.status, 'draft');
				}
			);

			await t.test('approve scoped drafts with conditional status (idempotent)', async () => {
				const roomBefore = await handle.db.query.rooms.findFirst({
					where: eq(rooms.id, ids.roomA1R1.roomId),
					columns: { debtAmount: true, status: true }
				});
				const debtBefore = roomBefore?.debtAmount ?? 0;

				const first = await readJson(
					await postDraftApprove({
						request: new Request('http://localhost/api/invoices/draft-approve', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ ids: [ext.draftA1] })
						}),
						locals: { actor: landlordA }
					} as Parameters<typeof postDraftApprove>[0])
				);
				assert.equal(first.status, 200);
				assert.deepEqual((first.body as { count: number }).count, 1);

				const approved = await handle.db.query.invoices.findFirst({
					where: eq(invoices.id, ext.draftA1),
					columns: { status: true }
				});
				assert.equal(approved?.status, 'pending');

				const roomAfter = await handle.db.query.rooms.findFirst({
					where: eq(rooms.id, ids.roomA1R1.roomId),
					columns: { debtAmount: true, status: true }
				});
				assert.equal(roomAfter?.status, 'debt');
				assert.equal(roomAfter?.debtAmount, debtBefore + 3_500_000);

				const second = await readJson(
					await postDraftApprove({
						request: new Request('http://localhost/api/invoices/draft-approve', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ ids: [ext.draftA1] })
						}),
						locals: { actor: landlordA }
					} as Parameters<typeof postDraftApprove>[0])
				);
				assert.equal(second.status, 404);
			});
		});
	}
);

test.after(closeSecurityDbPool);
