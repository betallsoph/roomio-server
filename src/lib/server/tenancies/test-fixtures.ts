/**
 * AUTH-006 — fixture cho test tích hợp PostgreSQL của service/endpoint tenancy.
 *
 * Không dùng chung `withSecurityDb` (nó TRUNCATE toàn bộ schema và cần `SECURITY_INTEGRATION=1`).
 * Ở đây mọi ID mang prefix runId duy nhất nên suite chạy song song với suite khác vẫn an toàn
 * và dọn dẹp chỉ đụng đúng row của mình.
 *
 * Guard: chỉ chạy khi `DATABASE_URL` trỏ tới PostgreSQL localhost có tên DB đánh dấu test.
 * KHÔNG khởi động Postgres/Docker local — CI (job quality) đã có service postgres.
 */

import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import {
	landlordProfiles,
	managedTenants,
	paymentAccounts,
	properties,
	rooms,
	tenantProfiles,
	users
} from '../db/schema.js';
import type { LandlordActor } from '../authorization/actor.js';

export type TenancyTestDb = NodePgDatabase<typeof schema>;

function isDisposableTestDb(raw: string): boolean {
	try {
		const parsed = new URL(raw);
		const localish = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
		return localish && /test|ci|disposable/i.test(parsed.pathname.replace(/^\//, ''));
	} catch {
		return false;
	}
}

/** Lý do skip cho node:test; `undefined` nghĩa là được phép chạy. */
export function tenancyIntegrationSkipReason(): string | undefined {
	const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
	if (!databaseUrl.startsWith('postgres')) {
		return 'PENDING_INTEGRATION: set DATABASE_URL to a postgres:// test database';
	}
	if (!isDisposableTestDb(databaseUrl)) {
		return 'PENDING_INTEGRATION: DATABASE_URL must point at a local disposable test database';
	}
	return undefined;
}

export function createTenancyTestPool(max = 4): Pool {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error('DATABASE_URL is required for tenancy integration tests');
	return new Pool({ connectionString: databaseUrl, max });
}

export type TenancyFixture = {
	runId: string;
	landlordA: { userId: string; landlordId: string; actor: LandlordActor };
	landlordB: { userId: string; landlordId: string; actor: LandlordActor };
	propertyA: string;
	propertyB: string;
	/** Ba phòng của landlord A để test race và checkout độc lập. */
	roomA1: string;
	roomA2: string;
	roomA3: string;
	roomB1: string;
	paymentAccountA: string;
	/** ManagedTenant chưa claim, KHÔNG có legacy TenantProfile. */
	managedTenantUnclaimed: string;
	/** ManagedTenant thứ hai chưa claim — dùng cho test race/occupant mới. */
	managedTenantUnclaimed2: string;
	/** ManagedTenant có `legacyTenantProfileId` để test dual-write cache legacy. */
	managedTenantLegacy: string;
	legacyTenantProfileId: string;
	legacyTenantUserId: string;
	/** ManagedTenant của landlord B — mọi thao tác chéo phải trả 404. */
	managedTenantB: string;
};

function landlordActor(userId: string, landlordId: string): LandlordActor {
	return { kind: 'USER', userId, role: 'LANDLORD', landlordId };
}

/** Seed topology A/B tối thiểu cho AUTH-006. Gọi `cleanupTenancyFixture` ở teardown. */
export async function seedTenancyFixture(db: TenancyTestDb): Promise<TenancyFixture> {
	const runId = `t6_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const id = (suffix: string) => `${runId}-${suffix}`;

	const userRow = (suffix: string, role: string) => ({
		id: id(suffix),
		email: `${runId}.${suffix}@tenancy.test`,
		phone: `${runId}.${suffix}`,
		passwordHash: 'tenancy-fixture-not-a-real-hash',
		name: `Fixture ${suffix}`,
		role,
		isActive: true
	});

	await db
		.insert(users)
		.values([userRow('ua', 'LANDLORD'), userRow('ub', 'LANDLORD'), userRow('utenant', 'TENANT')]);

	await db.insert(landlordProfiles).values([
		{ id: id('la'), userId: id('ua') },
		{ id: id('lb'), userId: id('ub') }
	]);

	await db.insert(tenantProfiles).values([{ id: id('tp'), userId: id('utenant') }]);

	await db.insert(properties).values([
		{
			id: id('pa'),
			landlordId: id('la'),
			name: 'Property A',
			shortName: 'PA',
			address: 'Fixture street'
		},
		{
			id: id('pb'),
			landlordId: id('lb'),
			name: 'Property B',
			shortName: 'PB',
			address: 'Fixture street'
		}
	]);

	await db.insert(paymentAccounts).values([
		{
			id: id('paccA'),
			landlordId: id('la'),
			name: 'Fixture account A',
			provider: 'vietqr',
			isDefault: true,
			isActive: true,
			bankName: 'Test Bank',
			bankCode: 'TESTBANK',
			accountNumber: '0000000000',
			accountName: 'FIXTURE A'
		}
	]);

	const room = (suffix: string, propertyId: string, roomNumber: string) => ({
		id: id(suffix),
		propertyId,
		roomNumber,
		roomType: 'standard',
		status: 'empty',
		monthlyRent: 3_000_000
	});

	await db
		.insert(rooms)
		.values([
			room('ra1', id('pa'), 'A101'),
			room('ra2', id('pa'), 'A102'),
			room('ra3', id('pa'), 'A103'),
			room('rb1', id('pb'), 'B101')
		]);

	await db.insert(managedTenants).values([
		{ id: id('mt1'), landlordId: id('la'), displayName: 'Managed unclaimed' },
		{ id: id('mt2'), landlordId: id('la'), displayName: 'Managed unclaimed 2' },
		{
			id: id('mt3'),
			landlordId: id('la'),
			displayName: 'Managed legacy',
			legacyTenantProfileId: id('tp'),
			backfillSource: 'LEGACY_TENANT_PROFILE'
		},
		{ id: id('mtb'), landlordId: id('lb'), displayName: 'Managed of landlord B' }
	]);

	return {
		runId,
		landlordA: {
			userId: id('ua'),
			landlordId: id('la'),
			actor: landlordActor(id('ua'), id('la'))
		},
		landlordB: {
			userId: id('ub'),
			landlordId: id('lb'),
			actor: landlordActor(id('ub'), id('lb'))
		},
		propertyA: id('pa'),
		propertyB: id('pb'),
		roomA1: id('ra1'),
		roomA2: id('ra2'),
		roomA3: id('ra3'),
		roomB1: id('rb1'),
		paymentAccountA: id('paccA'),
		managedTenantUnclaimed: id('mt1'),
		managedTenantUnclaimed2: id('mt2'),
		managedTenantLegacy: id('mt3'),
		legacyTenantProfileId: id('tp'),
		legacyTenantUserId: id('utenant'),
		managedTenantB: id('mtb')
	};
}

/**
 * Xóa theo thứ tự phụ thuộc: Tenancy dùng ON DELETE restrict nên phải đi trước Room/Property.
 * Dùng SQL thô với LIKE prefix để dọn cả row do test tạo ra ngoài fixture.
 */
export async function cleanupTenancyFixture(pool: Pool, fixture: TenancyFixture): Promise<void> {
	const prefix = `${fixture.runId}-%`;
	const landlordIds = [fixture.landlordA.landlordId, fixture.landlordB.landlordId];

	await pool.query(`DELETE FROM "AuditEvent" WHERE "landlordId" = ANY($1)`, [landlordIds]);
	await pool.query(`DELETE FROM "TenantInvite" WHERE "landlordId" = ANY($1) OR id LIKE $2`, [
		landlordIds,
		prefix
	]);
	await pool.query(
		`DELETE FROM "MeterReading" WHERE "roomId" IN (SELECT id FROM "Room" WHERE id LIKE $1)`,
		[prefix]
	);
	await pool.query(
		`DELETE FROM "Contract" WHERE "roomId" IN (SELECT id FROM "Room" WHERE id LIKE $1)`,
		[prefix]
	);
	await pool.query(`DELETE FROM "Tenancy" WHERE "landlordId" = ANY($1)`, [landlordIds]);
	await pool.query(
		`UPDATE "Room" SET "tenantId" = NULL, "currentManagedTenantId" = NULL
		WHERE id LIKE $1`,
		[prefix]
	);
	await pool.query(`DELETE FROM "ManagedTenant" WHERE "landlordId" = ANY($1)`, [landlordIds]);
	await pool.query(`DELETE FROM "Room" WHERE id LIKE $1`, [prefix]);
	await pool.query(`DELETE FROM "PaymentAccount" WHERE "landlordId" = ANY($1)`, [landlordIds]);
	await pool.query(`DELETE FROM "Property" WHERE "landlordId" = ANY($1)`, [landlordIds]);
	await pool.query(`DELETE FROM "TenantProfile" WHERE id LIKE $1`, [prefix]);
	await pool.query(`DELETE FROM "LandlordProfile" WHERE id = ANY($1)`, [landlordIds]);
	await pool.query(`DELETE FROM "User" WHERE id LIKE $1`, [prefix]);
}

/**
 * Đếm identity row THUỘC fixture này (theo `runId` và theo liên kết tới phòng của fixture)
 * để khẳng định service KHÔNG bịa `User`/`TenantProfile`.
 *
 * Cố ý KHÔNG `count(*)` toàn DB: CI chạy nhiều suite song song trên cùng một database nên
 * số tổng sẽ flaky. Row do service bịa ra luôn lộ ở một trong hai chỗ dưới đây: gắn vào
 * `User` của fixture, hoặc được `Room` của fixture trỏ tới.
 */
export async function countIdentityRows(
	db: TenancyTestDb,
	fixture: TenancyFixture
): Promise<{ users: number; tenantProfiles: number; roomLinkedProfiles: number }> {
	const prefix = `${fixture.runId}-%`;

	const userRows = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(users)
		.where(sql`${users.id} LIKE ${prefix} OR ${users.email} LIKE ${`${fixture.runId}%`}`);

	const profileRows = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(tenantProfiles)
		.where(sql`${tenantProfiles.id} LIKE ${prefix} OR ${tenantProfiles.userId} LIKE ${prefix}`);

	// TenantProfile bịa ra chỉ hữu ích khi được gắn vào phòng — đếm cả hướng đó.
	const roomLinkedRows = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(tenantProfiles)
		.innerJoin(rooms, eq(rooms.tenantId, tenantProfiles.id))
		.where(sql`${rooms.id} LIKE ${prefix}`);

	return {
		users: userRows[0]?.count ?? 0,
		tenantProfiles: profileRows[0]?.count ?? 0,
		roomLinkedProfiles: roomLinkedRows[0]?.count ?? 0
	};
}

export function createTenancyTestDb(pool: Pool): TenancyTestDb {
	return drizzle(pool, { schema });
}
