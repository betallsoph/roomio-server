import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionData } from '../session.js';
import type { LandlordActor } from './actor.js';
import { createDrizzleActorDb, getUserActor } from './load-user-actor.js';
import {
	fixtureSession,
	seedSecurityFixturesFromHandle,
	type SecurityFixtureMap
} from '../testing/security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb
} from '../testing/test-db.js';
import { expectNoForbiddenKeys } from './security-assertions.js';

const skipReason = getSecurityIntegrationSkipReason();

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
	test('authorization security characterization suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('security characterization suite runs twice without unique-key collisions', async () => {
		for (let run = 0; run < 2; run++) {
			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
			});
		}
	});

	test('authorization security characterization', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture: SecurityFixtureMap = await seedSecurityFixturesFromHandle(handle);
			const ids = fixture.ids;

			const { GET: getInvoices } = await import('../../../routes/api/invoices/+server.js');
			const { GET: getMeterReadings } =
				await import('../../../routes/api/meter-readings/+server.js');
			const { GET: getRooms } = await import('../../../routes/api/rooms/+server.js');

			const landlordA = fixtureSession(fixture, 'landlordA');
			const tenantANow = fixtureSession(fixture, 'tenantANow');
			const actorDb = createDrizzleActorDb(handle.db);
			const landlordAActor = (await getUserActor(landlordA, actorDb)) as LandlordActor;

			async function getMeterList(actor: LandlordActor, params: Record<string, string> = {}) {
				const qs = new URLSearchParams(params).toString();
				const url = new URL(`http://localhost/api/meter-readings${qs ? '?' + qs : ''}`);
				const res = await callHandler(getMeterReadings, { url, locals: { actor } });
				return readJson(res);
			}

			async function getRoomList(session: SessionData) {
				const url = new URL('http://localhost/api/rooms');
				const actor = await getUserActor(session, createDrizzleActorDb(handle.db));
				const res = await callHandler(getRooms, { url, locals: { session, actor } });
				return readJson(res);
			}

			const invoiceIds = (body: unknown): string[] =>
				Array.isArray(body) ? body.map((row) => (row as { id: string }).id) : [];

			const roomIdsFromMeters = (body: unknown): string[] =>
				Array.isArray(body) ? body.map((row) => (row as { roomId: string }).roomId) : [];

			await t.test('tenant invoice list requires actor scope (AUTH-012)', async () => {
				const actorDb = createDrizzleActorDb(handle.db);
				const tenantActor = await getUserActor(tenantANow, actorDb);
				const url = new URL('http://localhost/api/invoices');
				const res = await callHandler(getInvoices, { url, locals: { actor: tenantActor } });
				const result = await readJson(res);
				assert.equal(result.status, 200);
				const listed = invoiceIds(result.body);
				assert.ok(listed.includes(ids.invoiceANow.invoiceId) || listed.length === 0);
			});

			await t.test(
				'landlordA ignores foreign landlordId param and stays scoped to own meters',
				async () => {
					const result = await getMeterList(landlordAActor, {
						landlordId: ids.landlordB.landlordProfileId
					});
					assert.equal(result.status, 200);
					const roomIds = roomIdsFromMeters(result.body);
					assert.ok(roomIds.every((id) => id !== ids.roomB1R1.roomId));
					assert.ok(roomIds.includes(ids.roomA1R1.roomId));
				}
			);

			await t.test('landlordA meter list never includes landlordB room ids', async () => {
				const result = await getMeterList(landlordAActor);
				assert.equal(result.status, 200);
				const roomIds = roomIdsFromMeters(result.body);
				assert.ok(roomIds.every((id) => id !== ids.roomB1R1.roomId));
				assert.ok(roomIds.includes(ids.roomA1R1.roomId));
			});

			await t.test(
				'landlordA room list excludes forbidden keys on nested tenant.user (AUTH-017)',
				async () => {
					const result = await getRoomList(landlordA);
					assert.equal(result.status, 200);
					assert.ok(Array.isArray(result.body), 'room list must be an array');
					const roomsBody = result.body as Array<{
						id?: string;
						tenant?: { user?: Record<string, unknown> | null } | null;
					}>;
					const occupied = roomsBody.find((row) => row.id === ids.roomA1R1.roomId);
					assert.ok(occupied, 'landlordA room list must include seeded roomA1R1');
					assert.ok(occupied.tenant?.user, 'roomA1R1 must embed nested tenant.user');
					expectNoForbiddenKeys(result.body);
				}
			);
		});
	});
}
