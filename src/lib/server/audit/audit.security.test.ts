import assert from 'node:assert/strict';
import test from 'node:test';
import { count, eq } from 'drizzle-orm';
import { auditEvents } from '../db/schema.js';
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
import { AUDIT_ACTION_VERSION } from './actions.js';
import {
	auditActorMachine,
	auditActorSystem,
	type AuditActorRef
} from './actors.js';
import { appendAudit, type AppendAuditInput } from './append.js';
import { AuditValidationError } from './metadata.js';
import { validateAuditMetadata } from './metadata.js';
import { listLandlordAuditEvents, listPlatformAuditEvents } from './query.js';

const skipReason = getSecurityIntegrationSkipReason();

function landlordUserActor(
	fixture: SecurityFixtureMap,
	which: 'landlordA' | 'landlordB'
): AuditActorRef {
	const ids = fixture.ids[which];
	return {
		actorType: 'USER',
		actorUserId: ids.userId,
		actorRole: 'LANDLORD',
		landlordIdHint: ids.landlordProfileId
	};
}

function landlordAppendInput(
	fixture: SecurityFixtureMap,
	which: 'landlordA' | 'landlordB',
	overrides: Partial<AppendAuditInput> = {}
): AppendAuditInput {
	const landlordId = fixture.ids[which].landlordProfileId;
	return {
		scope: 'LANDLORD',
		landlordId,
		action: 'CONFIG.UPDATED',
		resourceType: 'LandlordProfile',
		resourceId: landlordId,
		requestId: `req-${which}-${fixture.runId}`,
		metadata: { settingKey: 'invoicePrefix', status: 'enabled' },
		...overrides
	};
}

async function countAuditRows(db: SecurityDbHandle['db']): Promise<number> {
	const [row] = await db.select({ value: count() }).from(auditEvents);
	return Number(row?.value ?? 0);
}

async function expectValidationError(run: () => unknown): Promise<void> {
	await assert.rejects(run, (error: unknown) => {
		assert.ok(error instanceof AuditValidationError);
		return true;
	});
}

if (skipReason) {
	test('audit security integration suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('audit security integration suite runs twice without fixture collisions', async () => {
		for (let run = 0; run < 2; run++) {
			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
			});
		}
	});

	test('audit security integration', async (t) => {
		await t.test('append in transaction then landlord query sees event for landlord A', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actor = landlordUserActor(fixture, 'landlordA');
				const event = landlordAppendInput(fixture, 'landlordA', {
					requestId: `happy-${fixture.runId}`
				});

				const { id } = await handle.db.transaction(async (tx) =>
					appendAudit(tx, actor, event)
				);

				const listed = await listLandlordAuditEvents(handle.db, {
					landlordId: fixture.ids.landlordA.landlordProfileId,
					limit: 20
				});

				assert.equal(listed.items.length, 1);
				assert.equal(listed.items[0]?.id, id);
				assert.equal(listed.items[0]?.action, 'CONFIG.UPDATED');
				assert.equal(listed.items[0]?.actorUserId, fixture.ids.landlordA.userId);
				assert.equal(listed.items[0]?.landlordId, fixture.ids.landlordA.landlordProfileId);
				assert.equal(listed.nextCursor, null);

				const [row] = await handle.db
					.select()
					.from(auditEvents)
					.where(eq(auditEvents.id, id));
				assert.ok(row);
				assert.equal(row.requestId, event.requestId);
			});
		});

		await t.test('append inside transaction then throw leaves no audit row', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actor = landlordUserActor(fixture, 'landlordA');
				const event = landlordAppendInput(fixture, 'landlordA', {
					requestId: `rollback-${fixture.runId}`
				});

				assert.equal(await countAuditRows(handle.db), 0);

				await assert.rejects(
					() =>
						handle.db.transaction(async (tx) => {
							await appendAudit(tx, actor, event);
							throw new Error('rollback probe');
						}),
					/rollback probe/
				);

				assert.equal(await countAuditRows(handle.db), 0);

				const listed = await listLandlordAuditEvents(handle.db, {
					landlordId: fixture.ids.landlordA.landlordProfileId,
					limit: 20
				});
				assert.deepEqual(listed.items, []);
			});
		});

		await t.test('landlord A list never includes landlord B audit events', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const requestA = `iso-a-${fixture.runId}`;
				const requestB = `iso-b-${fixture.runId}`;

				await handle.db.transaction(async (tx) => {
					await appendAudit(
						tx,
						landlordUserActor(fixture, 'landlordA'),
						landlordAppendInput(fixture, 'landlordA', { requestId: requestA })
					);
					await appendAudit(
						tx,
						landlordUserActor(fixture, 'landlordB'),
						landlordAppendInput(fixture, 'landlordB', { requestId: requestB })
					);
				});

				const listedA = await listLandlordAuditEvents(handle.db, {
					landlordId: fixture.ids.landlordA.landlordProfileId,
					limit: 50
				});
				const listedB = await listLandlordAuditEvents(handle.db, {
					landlordId: fixture.ids.landlordB.landlordProfileId,
					limit: 50
				});

				assert.equal(listedA.items.length, 1);
				assert.equal(listedB.items.length, 1);
				assert.equal(listedA.items[0]?.requestId, requestA);
				assert.equal(listedB.items[0]?.requestId, requestB);
				assert.ok(listedA.items.every((item) => item.landlordId === fixture.ids.landlordA.landlordProfileId));
				assert.ok(listedA.items.every((item) => item.requestId !== requestB));
				assert.ok(listedB.items.every((item) => item.requestId !== requestA));
			});
		});

		await t.test('platform list excludes landlord-scoped rows', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const platformRequestId = `platform-${fixture.runId}`;
				const landlordRequestId = `landlord-${fixture.runId}`;

				await handle.db.transaction(async (tx) => {
					await appendAudit(tx, auditActorSystem('security-test'), {
						scope: 'PLATFORM',
						landlordId: null,
						action: 'PLATFORM.BACKFILL_EXECUTED',
						resourceType: 'Platform',
						resourceId: 'platform',
						requestId: platformRequestId,
						metadata: { status: 'completed' }
					});
					await appendAudit(
						tx,
						landlordUserActor(fixture, 'landlordA'),
						landlordAppendInput(fixture, 'landlordA', { requestId: landlordRequestId })
					);
				});

				const platformListed = await listPlatformAuditEvents(handle.db, { limit: 50 });
				const landlordListed = await listLandlordAuditEvents(handle.db, {
					landlordId: fixture.ids.landlordA.landlordProfileId,
					limit: 50
				});

				assert.equal(platformListed.items.length, 1);
				assert.equal(platformListed.items[0]?.landlordId, null);
				assert.equal(platformListed.items[0]?.requestId, platformRequestId);
				assert.ok(platformListed.items.every((item) => item.requestId !== landlordRequestId));

				assert.equal(landlordListed.items.length, 1);
				assert.equal(landlordListed.items[0]?.requestId, landlordRequestId);
				assert.ok(landlordListed.items.every((item) => item.requestId !== platformRequestId));
			});
		});

		await t.test('machine and system actors accept null actorUserId', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const machineRequestId = `machine-${fixture.runId}`;
				const systemRequestId = `system-${fixture.runId}`;

				await handle.db.transaction(async (tx) => {
					await appendAudit(tx, auditActorMachine('CRON'), {
						scope: 'PLATFORM',
						landlordId: null,
						action: 'JOB.COMPLETED',
						resourceType: 'Job',
						resourceId: `job-${fixture.runId}`,
						requestId: machineRequestId,
						metadata: { status: 'completed', processedCount: '1' }
					});
					await appendAudit(tx, auditActorSystem('backfill'), {
						scope: 'PLATFORM',
						landlordId: null,
						action: 'PLATFORM.BACKFILL_EXECUTED',
						resourceType: 'Platform',
						resourceId: 'platform',
						requestId: systemRequestId,
						metadata: { status: 'completed' }
					});
				});

				const listed = await listPlatformAuditEvents(handle.db, { limit: 50 });
				assert.equal(listed.items.length, 2);

				const machineRow = listed.items.find((item) => item.requestId === machineRequestId);
				const systemRow = listed.items.find((item) => item.requestId === systemRequestId);
				assert.ok(machineRow);
				assert.ok(systemRow);
				assert.equal(machineRow.actorType, 'MACHINE');
				assert.equal(machineRow.actorUserId, null);
				assert.equal(systemRow.actorType, 'SYSTEM');
				assert.equal(systemRow.actorUserId, null);
			});
		});

		await t.test('metadata forbidden keys are rejected before insert', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const actor = landlordUserActor(fixture, 'landlordA');

				await expectValidationError(() =>
					validateAuditMetadata({ passwordHash: 'leak' }, AUDIT_ACTION_VERSION)
				);

				await expectValidationError(() =>
					handle.db.transaction(async (tx) =>
						appendAudit(
							tx,
							actor,
							landlordAppendInput(fixture, 'landlordA', {
								metadata: { userEmail: 'secret@example.com' }
							})
						)
					)
				);

				assert.equal(await countAuditRows(handle.db), 0);
			});
		});

		await t.test('USER actor without actorUserId is rejected', async () => {
			await withSecurityDb(async (handle) => {
				const fixture = await seedSecurityFixturesFromHandle(handle);
				const badActor: AuditActorRef = {
					actorType: 'USER',
					actorUserId: null,
					actorRole: 'LANDLORD',
					landlordIdHint: fixture.ids.landlordA.landlordProfileId
				};

				await expectValidationError(() =>
					handle.db.transaction(async (tx) =>
						appendAudit(tx, badActor, landlordAppendInput(fixture, 'landlordA'))
					)
				);

				assert.equal(await countAuditRows(handle.db), 0);
			});
		});
	});
}
