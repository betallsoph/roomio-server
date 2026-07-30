import assert from 'node:assert/strict';
import test from 'node:test';
import type { LandlordActor } from '$lib/server/authorization/actor.js';
import { invoices } from '$lib/server/db/schema.js';
import {
	seedSecurityFixturesFromHandle,
	type SecurityFixtureMap
} from '$lib/server/testing/security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb
} from '$lib/server/testing/test-db.js';
import { POST as postBulk } from './+server.js';

const skipReason = getSecurityIntegrationSkipReason();

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
	'AUTH-012 bulk — foreign room id fails whole request',
	async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const { ids } = fixture;
			const landlordA = landlordActor(fixture, 'landlordA');

			await t.test('POST mixed own/foreign roomIds → 404, no new invoices', async () => {
				const beforeCount = (await handle.db.select({ id: invoices.id }).from(invoices)).length;

				const res = await postBulk({
					request: new Request('http://localhost/api/invoices/bulk', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							propertyId: ids.propertyA1.propertyId,
							month: '2026-08',
							dueDate: '2026-08-10',
							readings: {},
							roomIds: [ids.roomA1R1.roomId, ids.roomB1R1.roomId]
						})
					}),
					locals: { actor: landlordA }
				} as Parameters<typeof postBulk>[0]);

				const result = await readJson(res);
				assert.equal(result.status, 404);

				const afterCount = (await handle.db.select({ id: invoices.id }).from(invoices)).length;
				assert.equal(afterCount, beforeCount);
			});

			await t.test('GET foreign propertyId → 404', async () => {
				const { GET: getBulk } = await import('./+server.js');
				const res = await getBulk({
					url: new URL(
						`http://localhost/api/invoices/bulk?propertyId=${ids.propertyB1.propertyId}&month=2026-08`
					),
					locals: { actor: landlordA }
				} as Parameters<typeof getBulk>[0]);
				assert.equal(res.status, 404);
			});
		});
	}
);

test.after(closeSecurityDbPool);
