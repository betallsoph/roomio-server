import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { contracts, rooms, tenancies } from '../db/schema.js';
import type { SessionData } from '../session.js';
import type { ActorContext } from '../authorization/actor.js';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { resetEnvForTests } from '../env.js';
import {
	cleanupTenancyFixture,
	createTenancyTestDb,
	createTenancyTestPool,
	seedTenancyFixture,
	tenancyIntegrationSkipReason,
	type TenancyFixture,
	type TenancyTestDb
} from './test-fixtures.js';
import { startTenancy } from './service.js';

// AUTH-006 — endpoint wiring: feature flag on/off, actor lấy từ locals.actor, map lỗi
// 401/403/404/409/422 và DTO không lộ field cấm. Chạy ở CI; tự skip khi không có DB test.

const skipReason = tenancyIntegrationSkipReason();

if (skipReason) {
	test('AUTH-006 endpoint wiring against real PostgreSQL', { skip: skipReason }, () => {});
} else {
	let pool: Pool;
	let db: TenancyTestDb;
	let fixture: TenancyFixture;

	const LEGACY_CHECKIN_EMAIL_MARKER = 'auth006-legacy-checkin';

	before(async () => {
		pool = createTenancyTestPool();
		db = createTenancyTestDb(pool);
		fixture = await seedTenancyFixture(db);
	});

	after(async () => {
		await cleanupLegacyCheckInRows();
		await cleanupTenancyFixture(pool, fixture);
		await pool.end();
		resetEnvForTests();
	});

	function setDualWriteFlag(enabled: boolean): void {
		resetEnvForTests({ ...process.env, TENANCY_DUAL_WRITE_ENABLED: enabled ? 'true' : 'false' });
	}

	function landlordSession(userId: string, landlordProfileId: string): SessionData {
		return {
			userId,
			role: 'LANDLORD',
			landlordProfileId,
			tenantProfileId: null,
			staffProfileId: null,
			staffLandlordId: null
		};
	}

	type TestLocals = {
		session: SessionData | null;
		actor: ActorContext | null;
		requestId: string;
	};

	function landlordLocals(): TestLocals {
		return {
			session: landlordSession(fixture.landlordA.userId, fixture.landlordA.landlordId),
			actor: fixture.landlordA.actor,
			requestId: 'req-auth006-test'
		};
	}

	/**
	 * RequestEvent tối giản: handler AUTH-006 chỉ đọc `request` + `locals`. Generic để
	 * TypeScript tự suy ra kiểu event của từng route handler mà không cần `any`.
	 */
	function requestEvent<T>(body: unknown, locals: TestLocals): T {
		return {
			request: new Request('http://localhost/api/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals
		} as unknown as T;
	}

	/** Cây JSON lỏng để assert bằng dot-access mà không dùng `any`. */
	type LooseJson = { [key: string]: LooseJson };

	async function readJson(response: Response): Promise<{ status: number; body: LooseJson }> {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			body = {};
		}
		return { status: response.status, body: (body ?? {}) as LooseJson };
	}

	async function cleanupLegacyCheckInRows(): Promise<void> {
		await pool.query(
			`DELETE FROM "Contract" WHERE "roomId" IN (SELECT id FROM "Room" WHERE id LIKE $1)`,
			[`${fixture.runId}-%`]
		);
		await pool.query(
			`DELETE FROM "TenantProfile" WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE $1)`,
			[`%${LEGACY_CHECKIN_EMAIL_MARKER}%`]
		);
		await pool.query(`DELETE FROM "User" WHERE email LIKE $1`, [
			`%${LEGACY_CHECKIN_EMAIL_MARKER}%`
		]);
	}

	async function resetBusinessRows(): Promise<void> {
		const landlordIds = [fixture.landlordA.landlordId, fixture.landlordB.landlordId];
		await cleanupLegacyCheckInRows();
		await pool.query(`DELETE FROM "AuditEvent" WHERE "landlordId" = ANY($1)`, [landlordIds]);
		await pool.query(
			`DELETE FROM "MeterReading" WHERE "roomId" IN (SELECT id FROM "Room" WHERE id LIKE $1)`,
			[`${fixture.runId}-%`]
		);
		await pool.query(`DELETE FROM "Tenancy" WHERE "landlordId" = ANY($1)`, [landlordIds]);
		await pool.query(
			`UPDATE "Room" SET "tenantId" = NULL, "currentManagedTenantId" = NULL, status = 'empty'
			 WHERE id LIKE $1`,
			[`${fixture.runId}-%`]
		);
	}

	async function activeTenanciesForLandlordA(): Promise<number> {
		const rows = await db
			.select({ id: tenancies.id })
			.from(tenancies)
			.where(eq(tenancies.landlordId, fixture.landlordA.landlordId));
		return rows.length;
	}

	async function countContractsForRoomA1(): Promise<number> {
		const rows = await db
			.select({ id: contracts.id })
			.from(contracts)
			.where(eq(contracts.roomId, fixture.roomA1));
		return rows.length;
	}

	/**
	 * Chỉ đếm User thuộc fixture (id hoặc email mang runId) — CI chạy nhiều suite song song
	 * trên cùng database nên `count(*)` toàn bảng sẽ flaky. Luồng legacy tự sinh email từ
	 * body test nên user "bịa ra" vẫn nằm trong prefix này.
	 */
	async function countUsers(): Promise<number> {
		const rows = await pool.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM "User" WHERE id LIKE $1 OR email LIKE $2`,
			[`${fixture.runId}-%`, `${fixture.runId}%`]
		);
		return Number(rows.rows[0]?.count ?? 0);
	}

	// --- Feature flag OFF -------------------------------------------------

	test('flag off keeps the legacy check-in flow and writes no tenancy', async () => {
		await resetBusinessRows();
		setDualWriteFlag(false);

		const { POST } = await import('../../../routes/api/tenants/+server.js');
		const response = await POST(
			requestEvent(
				{
					email: `${fixture.runId}.${LEGACY_CHECKIN_EMAIL_MARKER}@tenancy.test`,
					phone: `${fixture.runId}.legacy`,
					password: 'legacy-flow-password',
					name: 'Legacy check-in',
					roomId: fixture.roomA1,
					idNumber: '000000000000',
					moveInDate: '2026-07-01',
					deposit: 3_000_000
				},
				landlordLocals()
			)
		);

		const { status } = await readJson(response);
		assert.equal(status, 200);
		assert.equal(await activeTenanciesForLandlordA(), 0, 'legacy flow must not write Tenancy rows');

		const room = await db
			.select({ tenantId: rooms.tenantId, currentManagedTenantId: rooms.currentManagedTenantId })
			.from(rooms)
			.where(eq(rooms.id, fixture.roomA1));
		assert.notEqual(room[0]?.tenantId, null, 'legacy flow still writes the legacy occupant cache');
		assert.equal(room[0]?.currentManagedTenantId, null);
	});

	// --- Feature flag ON: check-in ---------------------------------------

	test('flag on rejects an unauthenticated caller with 401', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const { POST } = await import('../../../routes/api/tenants/+server.js');
		const response = await POST(
			requestEvent(
				{ roomId: fixture.roomA1, managedTenantId: fixture.managedTenantUnclaimed },
				{ session: null, actor: null, requestId: 'req-401' }
			)
		);
		assert.equal(response.status, 401);
		assert.equal(await activeTenanciesForLandlordA(), 0);
	});

	test('flag on rejects a tenant actor with 403', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const { POST } = await import('../../../routes/api/tenants/+server.js');
		const response = await POST(
			requestEvent(
				{ roomId: fixture.roomA1, managedTenantId: fixture.managedTenantUnclaimed },
				{
					session: null,
					actor: {
						kind: 'USER',
						userId: fixture.legacyTenantUserId,
						role: 'TENANT',
						tenantProfileId: fixture.legacyTenantProfileId
					},
					requestId: 'req-403'
				}
			)
		);
		assert.equal(response.status, 403);
		assert.equal(await activeTenanciesForLandlordA(), 0);
	});

	test('flag on requires managedTenantId with 422 and never invents identity', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const usersBefore = await countUsers();
		const { POST } = await import('../../../routes/api/tenants/+server.js');
		const response = await POST(
			requestEvent(
				{
					roomId: fixture.roomA1,
					// Email/phone mang runId để `countUsers()` (scope theo runId) bắt được
					// nếu endpoint lỡ tạo identity.
					email: `${fixture.runId}.should-not-create@tenancy.test`,
					phone: `${fixture.runId}.should-not-create`,
					password: 'should-not-be-used',
					name: 'Should not exist'
				},
				landlordLocals()
			)
		);

		const { status, body } = await readJson(response);
		assert.equal(status, 422);
		assert.equal(body.code, 'MANAGED_TENANT_REQUIRED');
		assert.equal(await countUsers(), usersBefore, 'no User may be created by a rejected check-in');
		assert.equal(await activeTenanciesForLandlordA(), 0);
	});

	test('flag on returns 404 for a room owned by another landlord and writes nothing', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const { POST } = await import('../../../routes/api/tenants/+server.js');
		const response = await POST(
			requestEvent(
				{ roomId: fixture.roomB1, managedTenantId: fixture.managedTenantUnclaimed },
				landlordLocals()
			)
		);

		const { status, body } = await readJson(response);
		assert.equal(status, 404);
		assert.equal(body.code, 'ROOM_NOT_FOUND');
		assert.equal(await activeTenanciesForLandlordA(), 0);
	});

	test('flag on check-in succeeds for an unclaimed managed tenant and leaks no forbidden keys', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const usersBefore = await countUsers();
		const { POST } = await import('../../../routes/api/tenants/+server.js');
		const response = await POST(
			requestEvent(
				{
					roomId: fixture.roomA1,
					managedTenantId: fixture.managedTenantUnclaimed,
					moveInDate: '2026-07-01',
					deposit: 3_000_000
				},
				landlordLocals()
			)
		);

		const { status, body } = await readJson(response);
		assert.equal(status, 201);
		assert.equal(body.tenancy.status, 'ACTIVE');
		assert.equal(body.tenancy.managedTenantId, fixture.managedTenantUnclaimed);
		assert.equal(body.tenancy.landlordId, fixture.landlordA.landlordId);

		expectNoForbiddenKeys(body);
		const serialized = JSON.stringify(body);
		for (const forbidden of ['passwordHash', 'email', 'phone', 'idNumber', 'idFrontImage']) {
			assert.equal(
				serialized.includes(forbidden),
				false,
				`check-in response must not expose ${forbidden}`
			);
		}
		assert.equal(await countUsers(), usersBefore, 'check-in must not create User rows');

		// Không có legacy profile → contract bị bỏ qua có lý do, không bịa TenantProfile.
		assert.equal(body.contract.created, false);
		assert.equal(body.contract.skippedReason, 'NO_LEGACY_TENANT_PROFILE');
	});

	test('flag on returns 409 when the room already has an active tenancy', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const { POST } = await import('../../../routes/api/tenants/+server.js');
		const first = await POST(
			requestEvent(
				{
					roomId: fixture.roomA1,
					managedTenantId: fixture.managedTenantUnclaimed,
					moveInDate: '2026-07-01'
				},
				landlordLocals()
			)
		);
		assert.equal(first.status, 201);

		const second = await POST(
			requestEvent(
				{
					roomId: fixture.roomA1,
					managedTenantId: fixture.managedTenantUnclaimed2,
					moveInDate: '2026-07-02'
				},
				landlordLocals()
			)
		);
		const { status, body } = await readJson(second);
		assert.equal(status, 409);
		assert.equal(body.code, 'ROOM_OCCUPIED');
		assert.equal(await activeTenanciesForLandlordA(), 1);
	});

	// --- Feature flag ON: checkout ---------------------------------------

	test('flag on checkout ends the tenancy, then returns 409 on the second call', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		const { PUT } = await import('../../../routes/api/rooms/+server.js');
		const first = await PUT(
			requestEvent(
				{ id: fixture.roomA1, action: 'checkout', endDate: '2026-08-01' },
				landlordLocals()
			)
		);
		assert.equal(first.status, 200);

		const tenancyRows = await db
			.select({ status: tenancies.status, endDate: tenancies.endDate })
			.from(tenancies)
			.where(eq(tenancies.id, started.tenancy.id));
		assert.equal(tenancyRows[0]?.status, 'ENDED');
		assert.equal(tenancyRows[0]?.endDate, '2026-08-01');

		const roomRows = await db
			.select({
				tenantId: rooms.tenantId,
				currentManagedTenantId: rooms.currentManagedTenantId
			})
			.from(rooms)
			.where(eq(rooms.id, fixture.roomA1));
		assert.equal(roomRows[0]?.currentManagedTenantId, null);
		assert.equal(roomRows[0]?.tenantId, null);

		const second = await PUT(
			requestEvent({ id: fixture.roomA1, action: 'checkout' }, landlordLocals())
		);
		const { status, body } = await readJson(second);
		assert.equal(status, 409);
		assert.equal(body.code, 'NO_ACTIVE_TENANCY');
	});

	test('checkout never clears or changes Room.debtAmount', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});
		// Công nợ tồn tại lúc trả phòng — quyết toán là việc của FIN, không phải AUTH-006.
		await db
			.update(rooms)
			.set({ debtAmount: 1_500_000, status: 'debt' })
			.where(eq(rooms.id, fixture.roomA1));

		const { PUT } = await import('../../../routes/api/rooms/+server.js');
		const response = await PUT(
			requestEvent(
				{ id: fixture.roomA1, action: 'checkout', endDate: '2026-08-01' },
				landlordLocals()
			)
		);
		assert.equal(response.status, 200);

		const roomRows = await db
			.select({ debtAmount: rooms.debtAmount, status: rooms.status })
			.from(rooms)
			.where(eq(rooms.id, fixture.roomA1));
		assert.equal(roomRows[0]?.debtAmount, 1_500_000, 'checkout must not wipe the debt');
		// Trạng thái vận hành phòng thuộc FIN-027; đường tenancy mới không ghi đè.
		assert.equal(roomRows[0]?.status, 'debt');
	});

	test('checkout on another landlord room returns 404, not 403', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const { PUT } = await import('../../../routes/api/rooms/+server.js');
		const foreign = await readJson(
			await PUT(requestEvent({ id: fixture.roomB1, action: 'checkout' }, landlordLocals()))
		);
		assert.equal(foreign.status, 404);
		assert.equal(foreign.body.code, 'ROOM_NOT_FOUND');

		// Phòng không tồn tại phải trả về đúng như phòng của chủ khác.
		const unknown = await readJson(
			await PUT(
				requestEvent({ id: `${fixture.runId}-no-such-room`, action: 'checkout' }, landlordLocals())
			)
		);
		assert.equal(unknown.status, 404);
		assert.deepEqual(unknown.body.code, foreign.body.code);
	});

	test('flag on checkout without a verified actor returns 401', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});

		const { PUT } = await import('../../../routes/api/rooms/+server.js');
		const response = await PUT(
			requestEvent(
				{ id: fixture.roomA1, action: 'checkout' },
				{
					// Session còn nhưng actor đã bị thu hồi ở request kế tiếp (AUTH-002).
					session: landlordSession(fixture.landlordA.userId, fixture.landlordA.landlordId),
					actor: null,
					requestId: 'req-checkout-401'
				}
			)
		);
		assert.equal(response.status, 401);

		const rows = await db
			.select({ status: tenancies.status })
			.from(tenancies)
			.where(eq(tenancies.landlordId, fixture.landlordA.landlordId));
		assert.equal(rows[0]?.status, 'ACTIVE', 'a rejected checkout must not end the tenancy');
	});

	// --- Feature flag ON: contract ---------------------------------------

	test('flag on contract creation snapshots tenancyId and managedTenantId', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		// ManagedTenant có legacy profile → Room.tenantId được dual-write, hợp đồng legacy
		// vẫn tạo được bằng tenantId cũ trong khi mang snapshot tenancy mới.
		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		const { POST } = await import('../../../routes/api/contracts/+server.js');
		const response = await POST(
			requestEvent(
				{
					tenantId: fixture.legacyTenantProfileId,
					roomId: fixture.roomA1,
					startDate: '2026-07-01',
					endDate: '2027-07-01',
					monthlyRent: 3_000_000,
					deposit: 3_000_000,
					paymentAccountId: fixture.paymentAccountA
				},
				landlordLocals()
			)
		);

		const { status, body } = await readJson(response);
		assert.equal(status, 201);
		expectNoForbiddenKeys(body);
		assert.equal(body.tenancyId, started.tenancy.id);
		assert.equal(body.managedTenantId, fixture.managedTenantLegacy);

		const rows = await db
			.select({ tenancyId: contracts.tenancyId, managedTenantId: contracts.managedTenantId })
			.from(contracts)
			.where(eq(contracts.roomId, fixture.roomA1));
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.tenancyId, started.tenancy.id);
		assert.equal(rows[0]?.managedTenantId, fixture.managedTenantLegacy);
	});

	test('flag on rejects a contract for a tenant who is not the room occupant', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		const { POST } = await import('../../../routes/api/contracts/+server.js');
		const { status, body } = await readJson(
			await POST(
				requestEvent(
					{
						// Client khai người thuê khác — body không phải authority.
						tenantId: `${fixture.runId}-other-profile`,
						roomId: fixture.roomA1,
						startDate: '2026-07-01',
						endDate: '2027-07-01',
						monthlyRent: 3_000_000
					},
					landlordLocals()
				)
			)
		);

		assert.equal(status, 409);
		assert.equal(body.code, 'CONTRACT_TENANT_MISMATCH');
		assert.equal(await countContractsForRoomA1(), 0);
	});

	test('flag on refuses a contract when the room has no active tenancy', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const { POST } = await import('../../../routes/api/contracts/+server.js');
		const { status, body } = await readJson(
			await POST(
				requestEvent(
					{
						tenantId: fixture.legacyTenantProfileId,
						roomId: fixture.roomA1,
						startDate: '2026-07-01',
						endDate: '2027-07-01',
						monthlyRent: 3_000_000
					},
					landlordLocals()
				)
			)
		);

		assert.equal(status, 409);
		assert.equal(body.code, 'NO_ACTIVE_TENANCY');
		assert.equal(await countContractsForRoomA1(), 0, 'no contract with null tenancy snapshot');
	});

	test('flag on returns 404 for a contract in another landlord room', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const { POST } = await import('../../../routes/api/contracts/+server.js');
		const { status, body } = await readJson(
			await POST(
				requestEvent(
					{
						tenantId: fixture.legacyTenantProfileId,
						roomId: fixture.roomB1,
						startDate: '2026-07-01',
						endDate: '2027-07-01',
						monthlyRent: 3_000_000
					},
					landlordLocals()
				)
			)
		);

		assert.equal(status, 404);
		assert.equal(body.code, 'ROOM_NOT_FOUND');
	});

	test('contract creation without a verified actor returns 401', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const { POST } = await import('../../../routes/api/contracts/+server.js');
		const response = await POST(
			requestEvent(
				{
					tenantId: fixture.legacyTenantProfileId,
					roomId: fixture.roomA1,
					startDate: '2026-07-01',
					endDate: '2027-07-01',
					monthlyRent: 3_000_000
				},
				{ session: null, actor: null, requestId: 'req-contract-401' }
			)
		);
		assert.equal(response.status, 401);
	});

	// --- Rollback flag: không được split-brain ----------------------------

	test('turning the flag off does not let the legacy check-in overwrite an active tenancy', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantUnclaimed,
			startDate: '2026-07-01'
		});

		// Rollback flag sau khi đã có Tenancy ACTIVE.
		setDualWriteFlag(false);

		const usersBefore = await countUsers();
		const { POST } = await import('../../../routes/api/tenants/+server.js');
		const { status, body } = await readJson(
			await POST(
				requestEvent(
					{
						email: `${fixture.runId}.${LEGACY_CHECKIN_EMAIL_MARKER}.split@tenancy.test`,
						phone: `${fixture.runId}.split`,
						password: 'legacy-flow-password',
						name: 'Split brain attempt',
						roomId: fixture.roomA1,
						idNumber: '000000000001',
						moveInDate: '2026-07-05',
						deposit: 3_000_000
					},
					landlordLocals()
				)
			)
		);

		assert.equal(status, 409);
		assert.equal(body.code, 'ROOM_OCCUPIED');
		assert.equal(
			await countUsers(),
			usersBefore,
			'no identity may be created for an occupied room'
		);
		assert.equal(await activeTenanciesForLandlordA(), 1);

		const roomRows = await db
			.select({ currentManagedTenantId: rooms.currentManagedTenantId })
			.from(rooms)
			.where(eq(rooms.id, fixture.roomA1));
		assert.equal(roomRows[0]?.currentManagedTenantId, fixture.managedTenantUnclaimed);
	});

	test('turning the flag off still binds a new contract to the existing tenancy', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		// Rollback flag: luồng legacy KHÔNG được tạo contract mồ côi song song lịch sử canonical.
		setDualWriteFlag(false);

		const { POST } = await import('../../../routes/api/contracts/+server.js');
		const { status, body } = await readJson(
			await POST(
				requestEvent(
					{
						tenantId: fixture.legacyTenantProfileId,
						roomId: fixture.roomA1,
						startDate: '2026-07-01',
						endDate: '2027-07-01',
						monthlyRent: 3_000_000
					},
					landlordLocals()
				)
			)
		);

		assert.equal(status, 201);
		assert.equal(body.tenancyId, started.tenancy.id);
		assert.equal(body.managedTenantId, fixture.managedTenantLegacy);

		const rows = await db
			.select({ tenancyId: contracts.tenancyId, managedTenantId: contracts.managedTenantId })
			.from(contracts)
			.where(eq(contracts.roomId, fixture.roomA1));
		assert.equal(rows.length, 1);
		assert.notEqual(rows[0]?.tenancyId, null, 'no orphan contract beside a canonical tenancy');
	});

	test('turning the flag off rejects a contract for the wrong tenant on a tenancy room', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		setDualWriteFlag(false);

		// TenantProfile hợp lệ với luồng legacy (đang ở phòng khác) nhưng KHÔNG phải người
		// thuê của lần thuê này — legacy guard cũ sẽ cho qua, guard mới phải chặn.
		const { POST } = await import('../../../routes/api/contracts/+server.js');
		const { status, body } = await readJson(
			await POST(
				requestEvent(
					{
						tenantId: `${fixture.runId}-not-the-occupant`,
						roomId: fixture.roomA1,
						startDate: '2026-07-01',
						endDate: '2027-07-01',
						monthlyRent: 3_000_000
					},
					landlordLocals()
				)
			)
		);

		// Body tenantId không thuộc phòng nào của chủ trọ → legacy ownership guard trả 403;
		// điều quan trọng là KHÔNG có contract nào được ghi.
		assert.ok(status === 403 || status === 409, `unexpected status ${status}`);
		if (status === 409) assert.equal(body.code, 'CONTRACT_TENANT_MISMATCH');
		assert.equal(await countContractsForRoomA1(), 0);
	});

	test('with the flag off and no tenancy the legacy contract flow is unchanged', async () => {
		await resetBusinessRows();
		setDualWriteFlag(false);

		// Phòng legacy: có occupant cache cũ, chưa có Tenancy nào.
		await db
			.update(rooms)
			.set({ tenantId: fixture.legacyTenantProfileId })
			.where(eq(rooms.id, fixture.roomA1));

		const { POST } = await import('../../../routes/api/contracts/+server.js');
		const { status } = await readJson(
			await POST(
				requestEvent(
					{
						tenantId: fixture.legacyTenantProfileId,
						roomId: fixture.roomA1,
						startDate: '2026-07-01',
						endDate: '2027-07-01',
						monthlyRent: 3_000_000
					},
					landlordLocals()
				)
			)
		);

		assert.equal(status, 200, 'legacy response shape must not change while the flag is off');
		const rows = await db
			.select({ tenancyId: contracts.tenancyId })
			.from(contracts)
			.where(eq(contracts.roomId, fixture.roomA1));
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.tenancyId, null);
	});

	test('turning the flag off still ends an existing tenancy on checkout', async () => {
		await resetBusinessRows();
		setDualWriteFlag(true);

		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: fixture.managedTenantLegacy,
			startDate: '2026-07-01'
		});

		setDualWriteFlag(false);

		const { PUT } = await import('../../../routes/api/rooms/+server.js');
		const response = await PUT(
			requestEvent(
				{ id: fixture.roomA1, action: 'checkout', endDate: '2026-08-01' },
				landlordLocals()
			)
		);
		assert.equal(response.status, 200);

		// Không được chỉ xóa cache legacy rồi để Tenancy treo ACTIVE.
		const tenancyRows = await db
			.select({ status: tenancies.status, endDate: tenancies.endDate })
			.from(tenancies)
			.where(eq(tenancies.id, started.tenancy.id));
		assert.equal(tenancyRows[0]?.status, 'ENDED');
		assert.equal(tenancyRows[0]?.endDate, '2026-08-01');

		const roomRows = await db
			.select({ tenantId: rooms.tenantId, currentManagedTenantId: rooms.currentManagedTenantId })
			.from(rooms)
			.where(eq(rooms.id, fixture.roomA1));
		assert.equal(roomRows[0]?.currentManagedTenantId, null);
		assert.equal(roomRows[0]?.tenantId, null);
	});
}
