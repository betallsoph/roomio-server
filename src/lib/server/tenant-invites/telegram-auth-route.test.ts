/**
 * AUTH-009 — POST /api/auth/telegram route: signed start_param trust + multi-claim.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, before } from 'node:test';
import type { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { managedTenants } from '../db/schema.js';
import { resetEnvForTests } from '../env.js';
import { createManagedTenant } from '../managed-tenants/service.js';
import { issueTenantInvite } from './service.js';
import {
	cleanupTenancyFixture,
	createTenancyTestDb,
	createTenancyTestPool,
	seedTenancyFixture,
	tenancyIntegrationSkipReason,
	type TenancyFixture,
	type TenancyTestDb
} from '../tenancies/test-fixtures.js';
import { startTenancy } from '../tenancies/service.js';

const BOT_TOKEN = '123456:auth009-telegram-route-test';
const skipReason = tenancyIntegrationSkipReason();

function createSignedInitData(options: { userId: number; startParam?: string }): string {
	const params = new URLSearchParams({
		auth_date: String(Math.floor(Date.now() / 1000)),
		query_id: 'auth009-route-test',
		user: JSON.stringify({ id: options.userId, first_name: 'Route', last_name: 'Tester' })
	});
	if (options.startParam) {
		params.set('start_param', options.startParam);
	}
	const dataCheckString = [...params.entries()]
		.filter(([key]) => key !== 'hash')
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join('\n');
	const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
	const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
	params.set('hash', hash);
	return params.toString();
}

type MockCookies = { values: Map<string, string>; set: (name: string, value: string) => void };

function mockCookies(): MockCookies {
	const values = new Map<string, string>();
	return {
		values,
		set(name: string, value: string) {
			values.set(name, value);
		}
	};
}

if (skipReason) {
	test('AUTH-009 telegram auth route', { skip: skipReason }, () => {});
} else {
	let pool: Pool;
	let db: TenancyTestDb;
	let fixture: TenancyFixture;
	const telegramUserId = 9_009_001_234;

	function ensureTelegramTestEnv(): void {
		resetEnvForTests({
			...process.env,
			BOT_TOKEN,
			BOT_USERNAME: 'roomio_bot',
			MINIAPP_SHORT_NAME: 'app',
			TENANCY_DUAL_WRITE_ENABLED: 'true'
		});
	}

	before(async () => {
		pool = createTenancyTestPool();
		db = createTenancyTestDb(pool);
		fixture = await seedTenancyFixture(db);
		ensureTelegramTestEnv();
	});

	after(async () => {
		await pool.query(`DELETE FROM "TenantInvite" WHERE "landlordId" = ANY($1)`, [
			[fixture.landlordA.landlordId, fixture.landlordB.landlordId]
		]);
		await pool.query(`DELETE FROM "User" WHERE id = $1`, [`tg-${telegramUserId}`]);
		await pool.query(`DELETE FROM "TenantProfile" WHERE "telegramUserId" = $1`, [
			String(telegramUserId)
		]);
		await cleanupTenancyFixture(pool, fixture);
		await pool.end();
		resetEnvForTests();
	});

	async function postTelegramAuth(body: Record<string, unknown>) {
		ensureTelegramTestEnv();
		const { POST } = await import('../../../routes/api/auth/telegram/+server.js');
		const cookies = mockCookies();
		const response = await POST({
			request: new Request('http://localhost/api/auth/telegram', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}),
			cookies: cookies as unknown as import('@sveltejs/kit').Cookies,
			locals: { requestId: 'auth009-telegram-route' }
		} as Parameters<typeof POST>[0]);
		const payload = await response.json();
		return { status: response.status, body: payload as Record<string, unknown> };
	}

	test('ignores unsigned body startParam when signed initData has no start_param', async () => {
		const managed = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'Unsigned body probe'
		});
		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: managed.id,
			startDate: '2026-07-10'
		});
		const issued = await issueTenantInvite(db, fixture.landlordA.actor, {
			managedTenantId: managed.id,
			tenancyId: started.tenancy.id
		});

		const initData = createSignedInitData({ userId: telegramUserId });
		const result = await postTelegramAuth({
			initData,
			startParam: issued.token
		});

		assert.equal(result.status, 403);
		assert.equal(result.body.error, 'NEEDS_INVITE');

		const row = await db
			.select({ claimedByUserId: managedTenants.claimedByUserId })
			.from(managedTenants)
			.where(eq(managedTenants.id, managed.id));
		assert.equal(row[0]?.claimedByUserId, null);
	});

	test('already linked Telegram user accepts a second invite via signed start_param', async () => {
		const firstManaged = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'First claim'
		});
		const firstTenancy = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA2,
			managedTenantId: firstManaged.id,
			startDate: '2026-07-11'
		});
		const firstInvite = await issueTenantInvite(db, fixture.landlordA.actor, {
			managedTenantId: firstManaged.id,
			tenancyId: firstTenancy.tenancy.id
		});

		const bootstrap = await postTelegramAuth({
			initData: createSignedInitData({ userId: telegramUserId, startParam: firstInvite.token })
		});
		assert.equal(bootstrap.status, 200);

		const secondManaged = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'Second claim'
		});
		const secondTenancy = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA3,
			managedTenantId: secondManaged.id,
			startDate: '2026-07-12'
		});
		const secondInvite = await issueTenantInvite(db, fixture.landlordA.actor, {
			managedTenantId: secondManaged.id,
			tenancyId: secondTenancy.tenancy.id
		});

		const multiClaim = await postTelegramAuth({
			initData: createSignedInitData({ userId: telegramUserId, startParam: secondInvite.token })
		});
		assert.equal(multiClaim.status, 200);

		const rows = await db
			.select({ id: managedTenants.id, claimedByUserId: managedTenants.claimedByUserId })
			.from(managedTenants)
			.where(eq(managedTenants.landlordId, fixture.landlordA.landlordId));

		const first = rows.find((row) => row.id === firstManaged.id);
		const second = rows.find((row) => row.id === secondManaged.id);
		assert.equal(first?.claimedByUserId, second?.claimedByUserId);
		assert.ok(first?.claimedByUserId?.startsWith('tg-'));
	});
}
