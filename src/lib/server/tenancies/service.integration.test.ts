import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import {
	auditEvents,
	contracts,
	managedTenants,
	rooms,
	tenancies,
	tenantInvites
} from '../db/schema.js';
import {
	cleanupTenancyFixture,
	countIdentityRows,
	createTenancyTestDb,
	createTenancyTestPool,
	seedTenancyFixture,
	tenancyIntegrationSkipReason,
	type TenancyFixture,
	type TenancyTestDb
} from './test-fixtures.js';
import {
	createContractForActiveTenancy,
	endActiveTenancyForRoom,
	endTenancy,
	hasActiveTenancyForRoom,
	startTenancy
} from './service.js';
import { isTenancyServiceError } from './state.js';

// AUTH-006 — kiểm hành vi THẬT trên PostgreSQL: transaction, unique partial index, race,
// dual-write cache và rollback. Chạy ở CI (job quality có postgres service); tự skip khi
// DATABASE_URL không trỏ tới DB test dùng một lần. KHÔNG khởi động Postgres/Docker local.

const skipReason = tenancyIntegrationSkipReason();

if (skipReason) {
	test('AUTH-006 tenancy service against real PostgreSQL', { skip: skipReason }, () => {});
} else {
	let pool: Pool;
	let db: TenancyTestDb;
	let fixture: TenancyFixture;

	before(async () => {
		pool = createTenancyTestPool();
		db = createTenancyTestDb(pool);
		fixture = await seedTenancyFixture(db);
	});

	after(async () => {
		await cleanupTenancyFixture(pool, fixture);
		// Dọn helper injection để DB test không giữ lại object thừa.
		await pool.query('DROP FUNCTION IF EXISTS auth006_injected_failure() CASCADE');
		await pool.end();
	});

	/** Đưa mọi row nghiệp vụ về trạng thái trống giữa các test, giữ nguyên fixture gốc. */
	async function resetBusinessRows(): Promise<void> {
		const landlordIds = [fixture.landlordA.landlordId, fixture.landlordB.landlordId];
		await pool.query(`DELETE FROM "AuditEvent" WHERE "landlordId" = ANY($1)`, [landlordIds]);
		await pool.query(`DELETE FROM "TenantInvite" WHERE "landlordId" = ANY($1)`, [landlordIds]);
		await pool.query(
			`DELETE FROM "Contract" WHERE "roomId" IN (SELECT id FROM "Room" WHERE id LIKE $1)`,
			[`${fixture.runId}-%`]
		);
		await pool.query(`DELETE FROM "Tenancy" WHERE "landlordId" = ANY($1)`, [landlordIds]);
		await pool.query(
			`UPDATE "Room" SET "tenantId" = NULL, "currentManagedTenantId" = NULL, status = 'empty'
			 WHERE id LIKE $1`,
			[`${fixture.runId}-%`]
		);
	}

	async function loadRoom(roomId: string) {
		const rows = await db
			.select({
				id: rooms.id,
				tenantId: rooms.tenantId,
				currentManagedTenantId: rooms.currentManagedTenantId
			})
			.from(rooms)
			.where(eq(rooms.id, roomId));
		return rows[0];
	}

	async function countTenancies(): Promise<number> {
		const rows = await db
			.select({ id: tenancies.id })
			.from(tenancies)
			.where(eq(tenancies.landlordId, fixture.landlordA.landlordId));
		return rows.length;
	}

	async function countContracts(): Promise<number> {
		const rows = await db
			.select({ id: contracts.id })
			.from(contracts)
			.where(eq(contracts.roomId, fixture.roomA1));
		return rows.length;
	}

	async function auditActionsFor(resourceId: string): Promise<string[]> {
		const rows = await db
			.select({ action: auditEvents.action })
			.from(auditEvents)
			.where(eq(auditEvents.resourceId, resourceId));
		return rows.map((row) => row.action);
	}

	/**
	 * Trigger chỉ bắn cho đúng row của test này — suite khác chạy song song không bị ảnh hưởng.
	 */
	async function withFailingInsert<T>(
		table: string,
		when: string,
		fn: () => Promise<T>
	): Promise<T> {
		const triggerName = `auth006_fail_${table.toLowerCase()}_${Date.now().toString(36)}`;
		await pool.query(
			`CREATE OR REPLACE FUNCTION auth006_injected_failure() RETURNS trigger AS $fn$
			 BEGIN RAISE EXCEPTION 'AUTH006_INJECTED_FAILURE'; END;
			 $fn$ LANGUAGE plpgsql`
		);
		await pool.query(
			`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "${table}"
			 FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION auth006_injected_failure()`
		);
		try {
			return await fn();
		} finally {
			await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${table}"`);
		}
	}

	// --- Happy path -------------------------------------------------------

	test('startTenancy creates the authoritative row and compatibility cache', async () => {
		await resetBusinessRows();

		const result = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01',
			depositRequired: 3_000_000
		});

		assert.equal(result.tenancy.status, 'ACTIVE');
		assert.equal(result.tenancy.managedTenantId, fixture.managedTenantUnclaimed);
		// Scope snapshot phải lấy từ DB, không từ input.
		assert.equal(result.tenancy.landlordId, fixture.landlordA.landlordId);
		assert.equal(result.tenancy.propertyId, fixture.propertyA);
		assert.equal(result.tenancy.roomId, fixture.roomA1);
		assert.equal(result.tenancy.depositRequired, '3000000');
		assert.equal(result.tenancy.endDate, null);

		const room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, fixture.managedTenantUnclaimed);
		// Không có legacy TenantProfile thì KHÔNG ghi cache legacy.
		assert.equal(room?.tenantId, null);
		assert.equal(result.legacyRoomTenantWritten, false);

		assert.deepEqual(await auditActionsFor(result.tenancy.id), ['TENANCY.CREATED']);
	});

	test('startTenancy works for an unclaimed managed tenant and invents no identity', async () => {
		await resetBusinessRows();

		const claimant = await db
			.select({ claimedByUserId: managedTenants.claimedByUserId })
			.from(managedTenants)
			.where(eq(managedTenants.id, fixture.managedTenantUnclaimed));
		assert.equal(claimant[0]?.claimedByUserId, null);

		const before = await countIdentityRows(db, fixture);
		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});
		const afterStart = await countIdentityRows(db, fixture);
		assert.deepEqual(afterStart, before, 'startTenancy must not create User/TenantProfile rows');

		const ended = await endTenancy(db, fixture.landlordA.actor, {
			tenancyId: started.tenancy.id,
			endDate: '2026-08-01'
		});
		assert.equal(ended.tenancy.status, 'ENDED');
		assert.equal(ended.tenancy.endDate, '2026-08-01');

		const afterEnd = await countIdentityRows(db, fixture);
		assert.deepEqual(afterEnd, before, 'endTenancy must not create User/TenantProfile rows');
	});

	test('legacy Room.tenantId is dual-written only when a legacy profile exists', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});
		assert.equal(started.legacyRoomTenantWritten, true);

		let room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, fixture.managedTenantLegacy);
		assert.equal(room?.tenantId, fixture.legacyTenantProfileId);

		const ended = await endTenancy(db, fixture.landlordA.actor, {
			tenancyId: started.tenancy.id,
			endDate: '2026-08-01'
		});
		assert.equal(ended.roomCacheCleared, true);
		assert.equal(ended.legacyRoomTenantCleared, true);

		room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, null);
		assert.equal(room?.tenantId, null);
	});

	// --- Cách ly landlord -------------------------------------------------

	test('room A with landlord B managed tenant returns 404 and writes nothing', async () => {
		await resetBusinessRows();

		await assert.rejects(
			() =>
				startTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					managedTenantId: fixture.managedTenantB,
					startDate: '2026-07-01'
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'MANAGED_TENANT_NOT_FOUND');
				assert.equal(error.status, 404);
				return true;
			}
		);

		assert.equal(await countTenancies(), 0);
		const room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, null);
	});

	test('landlord A cannot start a tenancy in landlord B room', async () => {
		await resetBusinessRows();

		await assert.rejects(
			() =>
				startTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomB1,
					managedTenantId: fixture.managedTenantUnclaimed,
					startDate: '2026-07-01'
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'ROOM_NOT_FOUND');
				assert.equal(error.status, 404);
				return true;
			}
		);

		const room = await loadRoom(fixture.roomB1);
		assert.equal(room?.currentManagedTenantId, null);
	});

	test('unknown ids are indistinguishable from foreign ids', async () => {
		await resetBusinessRows();

		await assert.rejects(
			() =>
				startTenancy(db, fixture.landlordA.actor, {
					roomId: `${fixture.runId}-does-not-exist`,
					managedTenantId: fixture.managedTenantUnclaimed
				}),
			(error: unknown) => isTenancyServiceError(error) && error.code === 'ROOM_NOT_FOUND'
		);

		await assert.rejects(
			() =>
				startTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					managedTenantId: `${fixture.runId}-nope`
				}),
			(error: unknown) => isTenancyServiceError(error) && error.code === 'MANAGED_TENANT_NOT_FOUND'
		);
	});

	// --- Race / trùng lặp -------------------------------------------------

	test('duplicate start on the same room returns 409', async () => {
		await resetBusinessRows();

		await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});

		await assert.rejects(
			() =>
				startTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					managedTenantId: fixture.managedTenantUnclaimed2,
					startDate: '2026-07-02'
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'ROOM_OCCUPIED');
				assert.equal(error.status, 409);
				return true;
			}
		);

		assert.equal(await countTenancies(), 1);
	});

	test('concurrent starts on one room: exactly one succeeds, the other gets 409', async () => {
		await resetBusinessRows();

		const attempts = [
			startTenancy(db, fixture.landlordA.actor, {
				roomId: fixture.roomA2,
				managedTenantId: fixture.managedTenantUnclaimed,
				startDate: '2026-07-01'
			}),
			startTenancy(db, fixture.landlordA.actor, {
				roomId: fixture.roomA2,
				managedTenantId: fixture.managedTenantUnclaimed2,
				startDate: '2026-07-01'
			})
		];

		const results = await Promise.allSettled(attempts);
		const fulfilled = results.filter((item) => item.status === 'fulfilled');
		const rejected = results.filter((item) => item.status === 'rejected');

		assert.equal(fulfilled.length, 1, 'exactly one concurrent start may win');
		assert.equal(rejected.length, 1);
		const error = (rejected[0] as PromiseRejectedResult).reason;
		assert.ok(isTenancyServiceError(error));
		assert.equal(error.status, 409);
		assert.equal(await countTenancies(), 1);
	});

	test('concurrent starts for one managed tenant in two rooms: one succeeds, one 409', async () => {
		await resetBusinessRows();

		const results = await Promise.allSettled([
			startTenancy(db, fixture.landlordA.actor, {
				roomId: fixture.roomA1,
				managedTenantId: fixture.managedTenantUnclaimed,
				startDate: '2026-07-01'
			}),
			startTenancy(db, fixture.landlordA.actor, {
				roomId: fixture.roomA3,
				managedTenantId: fixture.managedTenantUnclaimed,
				startDate: '2026-07-01'
			})
		]);

		assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
		const rejection = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
		assert.ok(isTenancyServiceError(rejection.reason));
		assert.equal(rejection.reason.status, 409);
		assert.equal(await countTenancies(), 1);
	});

	// --- Kết thúc lần thuê ------------------------------------------------

	test('ending twice returns 409 on the second call (stable contract)', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});

		await endTenancy(db, fixture.landlordA.actor, {
			tenancyId: started.tenancy.id,
			endDate: '2026-08-01'
		});

		await assert.rejects(
			() =>
				endTenancy(db, fixture.landlordA.actor, {
					tenancyId: started.tenancy.id,
					endDate: '2026-08-02'
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'TENANCY_NOT_ACTIVE');
				assert.equal(error.status, 409);
				return true;
			}
		);

		const rows = await db
			.select({ endDate: tenancies.endDate, endedByUserId: tenancies.endedByUserId })
			.from(tenancies)
			.where(eq(tenancies.id, started.tenancy.id));
		// Lần end thứ hai không được ghi đè dữ liệu của lần end đầu.
		assert.equal(rows[0]?.endDate, '2026-08-01');
		assert.equal(rows[0]?.endedByUserId, fixture.landlordA.userId);
	});

	test('ending an old tenancy never clears a newer occupant cache', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});

		// Giả lập check-in mới đã ghi cache occupant khác trong lúc checkout cũ đang chạy.
		await db
			.update(rooms)
			.set({ currentManagedTenantId: fixture.managedTenantUnclaimed2 })
			.where(eq(rooms.id, fixture.roomA1));

		const ended = await endTenancy(db, fixture.landlordA.actor, {
			tenancyId: started.tenancy.id,
			endDate: '2026-08-01'
		});

		assert.equal(ended.tenancy.status, 'ENDED');
		assert.equal(ended.roomCacheCleared, false);

		const room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, fixture.managedTenantUnclaimed2);
	});

	test('endTenancy is scoped by landlord and revokes pending invites', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		await db.insert(tenantInvites).values({
			id: `${fixture.runId}-invite-1`,
			landlordId: fixture.landlordA.landlordId,
			tenantId: fixture.legacyTenantProfileId,
			token: `${fixture.runId}-token`,
			expiresAt: new Date(Date.now() + 86_400_000),
			managedTenantId: fixture.managedTenantLegacy,
			tenancyId: started.tenancy.id,
			status: 'PENDING',
			purpose: 'INITIAL_CLAIM'
		});

		// Landlord B không được đụng tenancy của landlord A.
		await assert.rejects(
			() => endTenancy(db, fixture.landlordB.actor, { tenancyId: started.tenancy.id }),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'TENANCY_NOT_FOUND');
				assert.equal(error.status, 404);
				return true;
			}
		);

		const stillActive = await db
			.select({ status: tenancies.status })
			.from(tenancies)
			.where(eq(tenancies.id, started.tenancy.id));
		assert.equal(stillActive[0]?.status, 'ACTIVE');

		const ended = await endTenancy(db, fixture.landlordA.actor, {
			tenancyId: started.tenancy.id,
			endDate: '2026-08-01'
		});
		assert.equal(ended.pendingInvitesRevoked, 1);

		const invite = await db
			.select({ status: tenantInvites.status })
			.from(tenantInvites)
			.where(eq(tenantInvites.id, `${fixture.runId}-invite-1`));
		assert.equal(invite[0]?.status, 'REVOKED');

		assert.deepEqual((await auditActionsFor(started.tenancy.id)).sort(), [
			'TENANCY.CREATED',
			'TENANCY.TERMINATED'
		]);
	});

	test('endActiveTenancyForRoom resolves the active tenancy and rejects empty rooms', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});

		const ended = await endActiveTenancyForRoom(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			endDate: '2026-08-01'
		});
		assert.equal(ended.tenancy.id, started.tenancy.id);
		assert.equal(ended.tenancy.status, 'ENDED');

		await assert.rejects(
			() => endActiveTenancyForRoom(db, fixture.landlordA.actor, { roomId: fixture.roomA1 }),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'NO_ACTIVE_TENANCY');
				assert.equal(error.status, 409);
				return true;
			}
		);

		await assert.rejects(
			() => endActiveTenancyForRoom(db, fixture.landlordA.actor, { roomId: fixture.roomB1 }),
			(error: unknown) => isTenancyServiceError(error) && error.code === 'ROOM_NOT_FOUND'
		);
	});

	// --- Contract ---------------------------------------------------------

	test('a contract created by the flow carries tenancyId and managedTenantId', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01',
			contract: {
				endDate: '2027-07-01',
				deposit: 3_000_000,
				paymentAccountId: fixture.paymentAccountA
			}
		});

		assert.equal(started.contract.created, true);
		assert.equal(started.contract.skippedReason, null);

		const rows = await db
			.select({
				id: contracts.id,
				tenancyId: contracts.tenancyId,
				managedTenantId: contracts.managedTenantId,
				tenantId: contracts.tenantId,
				monthlyRent: contracts.monthlyRent,
				startDate: contracts.startDate
			})
			.from(contracts)
			.where(eq(contracts.roomId, fixture.roomA1));

		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.tenancyId, started.tenancy.id);
		assert.equal(rows[0]?.managedTenantId, fixture.managedTenantLegacy);
		assert.equal(rows[0]?.tenantId, fixture.legacyTenantProfileId);
		// monthlyRent lấy từ Room đã load trong transaction, không từ body.
		assert.equal(rows[0]?.monthlyRent, 3_000_000);
		assert.equal(rows[0]?.startDate, '2026-07-01');
	});

	test('createContractForActiveTenancy derives every tenant id from the database', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		const contract = await createContractForActiveTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			startDate: '2026-07-01',
			endDate: '2027-07-01',
			paymentAccountId: fixture.paymentAccountA
		});

		assert.equal(contract.tenancyId, started.tenancy.id);
		assert.equal(contract.managedTenantId, fixture.managedTenantLegacy);
		assert.equal(contract.tenantId, fixture.legacyTenantProfileId);
		// monthlyRent bỏ trống → lấy từ Room đã load trong transaction.
		assert.equal(contract.monthlyRent, 3_000_000);
	});

	test('a contract can never be attached to another tenant than the room occupant', async () => {
		await resetBusinessRows();

		await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		// Body khai TenantProfile khác người thuê thật của phòng.
		await assert.rejects(
			() =>
				createContractForActiveTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					startDate: '2026-07-01',
					endDate: '2027-07-01',
					expectedLegacyTenantProfileId: `${fixture.runId}-someone-else`
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'CONTRACT_TENANT_MISMATCH');
				assert.equal(error.status, 409);
				return true;
			}
		);

		assert.equal(await countContracts(), 0, 'a mismatched tenant must not create a contract');
	});

	test('a contract is refused when the room has no active tenancy', async () => {
		await resetBusinessRows();

		await assert.rejects(
			() =>
				createContractForActiveTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					startDate: '2026-07-01',
					endDate: '2027-07-01'
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'NO_ACTIVE_TENANCY');
				assert.equal(error.status, 409);
				return true;
			}
		);

		assert.equal(await countContracts(), 0, 'no orphan contract with null tenancy snapshot');
	});

	test('a contract is refused when the managed tenant has no legacy profile', async () => {
		await resetBusinessRows();

		await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});

		const before = await countIdentityRows(db, fixture);
		await assert.rejects(
			() =>
				createContractForActiveTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					startDate: '2026-07-01',
					endDate: '2027-07-01'
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'NO_LEGACY_TENANT_PROFILE');
				assert.equal(error.status, 409);
				return true;
			}
		);

		assert.deepEqual(await countIdentityRows(db, fixture), before, 'no TenantProfile invented');
		assert.equal(await countContracts(), 0);
	});

	test('a contract in another landlord room returns 404 and writes nothing', async () => {
		await resetBusinessRows();

		await assert.rejects(
			() =>
				createContractForActiveTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomB1,
					startDate: '2026-07-01',
					endDate: '2027-07-01'
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'ROOM_NOT_FOUND');
				assert.equal(error.status, 404);
				return true;
			}
		);

		assert.equal(await countContracts(), 0);
	});

	test('contract creation cannot race a concurrent checkout', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		// Giữ lock trên row tenancy để lệnh tạo contract phải xếp hàng, rồi kết thúc lần
		// thuê trước khi nhả lock: contract KHÔNG được gắn vào tenancy đã ENDED.
		const blocker = await pool.connect();
		let contractAttempt: Promise<unknown>;
		try {
			await blocker.query('BEGIN');
			await blocker.query('SELECT id FROM "Tenancy" WHERE id = $1 FOR UPDATE', [
				started.tenancy.id
			]);

			contractAttempt = createContractForActiveTenancy(db, fixture.landlordA.actor, {
				roomId: fixture.roomA1,
				startDate: '2026-07-01',
				endDate: '2027-07-01'
			});
			// Cho lệnh trên kịp chạm lock trước khi checkout commit.
			await new Promise((resolve) => setTimeout(resolve, 150));

			await blocker.query(
				`UPDATE "Tenancy" SET status = 'ENDED', "endDate" = '2026-08-01' WHERE id = $1`,
				[started.tenancy.id]
			);
			await blocker.query('COMMIT');
		} finally {
			blocker.release();
		}

		await assert.rejects(
			() => contractAttempt,
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'NO_ACTIVE_TENANCY');
				return true;
			}
		);
		assert.equal(await countContracts(), 0, 'no contract may point at an ended tenancy');
	});

	test('contract is skipped, not faked, when the managed tenant has no legacy profile', async () => {
		await resetBusinessRows();

		const before = await countIdentityRows(db, fixture);
		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01',
			contract: { endDate: '2027-07-01' }
		});
		const afterStart = await countIdentityRows(db, fixture);

		assert.equal(started.contract.created, false);
		assert.equal(started.contract.skippedReason, 'NO_LEGACY_TENANT_PROFILE');
		assert.deepEqual(afterStart, before, 'no TenantProfile may be invented for a contract');

		const rows = await db
			.select({ id: contracts.id })
			.from(contracts)
			.where(eq(contracts.roomId, fixture.roomA1));
		assert.equal(rows.length, 0);
		// Tenancy vẫn tồn tại: bỏ qua contract không được làm hỏng lần thuê.
		assert.equal(await countTenancies(), 1);
	});

	test('a foreign payment account on the contract input is rejected with 404', async () => {
		await resetBusinessRows();

		await assert.rejects(
			() =>
				startTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					managedTenantId: fixture.managedTenantLegacy,
					contract: { endDate: '2027-07-01', paymentAccountId: `${fixture.runId}-foreign-acc` }
				}),
			(error: unknown) => isTenancyServiceError(error) && error.code === 'PAYMENT_ACCOUNT_NOT_FOUND'
		);

		assert.equal(await countTenancies(), 0);
	});

	// --- Rollback ---------------------------------------------------------

	test('a failing audit append rolls back the whole start transaction', async () => {
		await resetBusinessRows();

		await withFailingInsert(
			'AuditEvent',
			`NEW."landlordId" = '${fixture.landlordA.landlordId}'`,
			async () => {
				await assert.rejects(
					() =>
						startTenancy(db, fixture.landlordA.actor, {
							roomId: fixture.roomA1,
							managedTenantId: fixture.managedTenantUnclaimed,
							startDate: '2026-07-01'
						}),
					/AUTH006_INJECTED_FAILURE/
				);
			}
		);

		assert.equal(await countTenancies(), 0);
		const room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, null, 'room cache must roll back with the tenancy');
	});

	test('a failing contract insert rolls back the whole start transaction', async () => {
		await resetBusinessRows();

		await withFailingInsert('Contract', `NEW."roomId" = '${fixture.roomA1}'`, async () => {
			await assert.rejects(
				() =>
					startTenancy(db, fixture.landlordA.actor, {
						roomId: fixture.roomA1,
						managedTenantId: fixture.managedTenantLegacy,
						startDate: '2026-07-01',
						contract: { endDate: '2027-07-01' }
					}),
				/AUTH006_INJECTED_FAILURE/
			);
		});

		assert.equal(await countTenancies(), 0);
		const room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, null);
		assert.equal(room?.tenantId, null, 'legacy cache must roll back too');
	});

	test('a failing audit append rolls back the whole end transaction', async () => {
		await resetBusinessRows();

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});

		await withFailingInsert(
			'AuditEvent',
			`NEW."landlordId" = '${fixture.landlordA.landlordId}'`,
			async () => {
				await assert.rejects(
					() =>
						endTenancy(db, fixture.landlordA.actor, {
							tenancyId: started.tenancy.id,
							endDate: '2026-08-01'
						}),
					/AUTH006_INJECTED_FAILURE/
				);
			}
		);

		const rows = await db
			.select({ status: tenancies.status, endDate: tenancies.endDate })
			.from(tenancies)
			.where(and(eq(tenancies.id, started.tenancy.id), eq(tenancies.status, 'ACTIVE')));
		assert.equal(rows.length, 1, 'tenancy must stay ACTIVE when the audit append fails');
		assert.equal(rows[0]?.endDate, null);

		const room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, fixture.managedTenantUnclaimed);
	});

	// --- Fail closed trên cache occupant cũ --------------------------------

	test('a legacy occupant cache without an active tenancy blocks a new start', async () => {
		await resetBusinessRows();
		// Phòng legacy: có người ở trong cache cũ nhưng chưa backfill Tenancy (AUTH-007).
		await db
			.update(rooms)
			.set({ tenantId: fixture.legacyTenantProfileId })
			.where(eq(rooms.id, fixture.roomA1));

		await assert.rejects(
			() =>
				startTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					managedTenantId: fixture.managedTenantUnclaimed,
					startDate: '2026-07-01'
				}),
			(error: unknown) => {
				assert.ok(isTenancyServiceError(error));
				assert.equal(error.code, 'ROOM_CACHE_CONFLICT');
				assert.equal(error.status, 409);
				return true;
			}
		);

		const room = await loadRoom(fixture.roomA1);
		// Người ở cũ KHÔNG bị ghi đè.
		assert.equal(room?.tenantId, fixture.legacyTenantProfileId);
		assert.equal(room?.currentManagedTenantId, null);
		assert.equal(await countTenancies(), 0);
	});

	test('a stale currentManagedTenantId cache blocks a new start', async () => {
		await resetBusinessRows();
		await db
			.update(rooms)
			.set({ currentManagedTenantId: fixture.managedTenantUnclaimed2 })
			.where(eq(rooms.id, fixture.roomA1));

		await assert.rejects(
			() =>
				startTenancy(db, fixture.landlordA.actor, {
					roomId: fixture.roomA1,
					managedTenantId: fixture.managedTenantUnclaimed
				}),
			(error: unknown) => isTenancyServiceError(error) && error.code === 'ROOM_CACHE_CONFLICT'
		);

		const room = await loadRoom(fixture.roomA1);
		assert.equal(room?.currentManagedTenantId, fixture.managedTenantUnclaimed2);
		assert.equal(await countTenancies(), 0);
	});

	test('hasActiveTenancyForRoom reports the split-brain guard state', async () => {
		await resetBusinessRows();
		assert.equal(await hasActiveTenancyForRoom(db, fixture.roomA1), false);

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});
		assert.equal(await hasActiveTenancyForRoom(db, fixture.roomA1), true);

		await endTenancy(db, fixture.landlordA.actor, {
			tenancyId: started.tenancy.id,
			endDate: '2026-08-01'
		});
		assert.equal(await hasActiveTenancyForRoom(db, fixture.roomA1), false);
	});

	// --- Archive ----------------------------------------------------------

	test('an archived managed tenant cannot start a new tenancy', async () => {
		await resetBusinessRows();
		await db
			.update(managedTenants)
			.set({ status: 'ARCHIVED', archivedAt: new Date() })
			.where(eq(managedTenants.id, fixture.managedTenantUnclaimed2));

		try {
			await assert.rejects(
				() =>
					startTenancy(db, fixture.landlordA.actor, {
						roomId: fixture.roomA1,
						managedTenantId: fixture.managedTenantUnclaimed2
					}),
				(error: unknown) => {
					assert.ok(isTenancyServiceError(error));
					assert.equal(error.code, 'MANAGED_TENANT_ARCHIVED');
					assert.equal(error.status, 409);
					return true;
				}
			);
			assert.equal(await countTenancies(), 0);
		} finally {
			await db
				.update(managedTenants)
				.set({ status: 'ACTIVE', archivedAt: null })
				.where(eq(managedTenants.id, fixture.managedTenantUnclaimed2));
		}
	});
}
