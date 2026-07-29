/**
 * AUTH-009 — integration tests for managed tenant create + invite claim flows.
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { Pool } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import {
	auditEvents,
	managedTenants,
	tenantInvites,
	tenantProfiles,
	tenancies,
	users
} from '../db/schema.js';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { resetEnvForTests } from '../env.js';
import { createManagedTenant } from './service.js';
import { issueTenantInvite, acceptTenantInvite } from '../tenant-invites/service.js';
import { hashInviteToken } from '../tenant-invites/token.js';
import { isTenantInviteServiceError } from '../tenant-invites/state.js';
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

const skipReason = tenancyIntegrationSkipReason();

if (skipReason) {
	test('AUTH-009 managed tenant + invite integration', { skip: skipReason }, () => {});
} else {
	let pool: Pool;
	let db: TenancyTestDb;
	let fixture: TenancyFixture;

	before(async () => {
		pool = createTenancyTestPool();
		db = createTenancyTestDb(pool);
		fixture = await seedTenancyFixture(db);
		resetEnvForTests({ ...process.env, TENANCY_DUAL_WRITE_ENABLED: 'true' });
	});

	after(async () => {
		await cleanupAuth009Rows();
		await cleanupTenancyFixture(pool, fixture);
		await pool.end();
		resetEnvForTests();
	});

	async function cleanupAuth009Rows(): Promise<void> {
		const landlordIds = [fixture.landlordA.landlordId, fixture.landlordB.landlordId];
		await pool.query(`DELETE FROM "AuditEvent" WHERE "landlordId" = ANY($1)`, [landlordIds]);
		await pool.query(`DELETE FROM "TenantInvite" WHERE "landlordId" = ANY($1)`, [landlordIds]);
		await pool.query(`DELETE FROM "ManagedTenant" WHERE "landlordId" = $1 AND id LIKE $2`, [
			fixture.landlordA.landlordId,
			`${fixture.runId}-auth009-%`
		]);
		await pool.query(`DELETE FROM "TenantProfile" WHERE id LIKE $1`, [`invite-anchor-profile-%`]);
		await pool.query(`DELETE FROM "User" WHERE id LIKE $1`, [`invite-anchor-%`]);
		await pool.query(`DELETE FROM "User" WHERE id LIKE $1`, [`tg-%`]);
		await pool.query(`DELETE FROM "TenantProfile" WHERE id LIKE $1`, [`tg-profile-%`]);
	}

	async function countUsersLike(prefix: string): Promise<number> {
		const rows = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(users)
			.where(sql`${users.id} LIKE ${prefix}`);
		return rows[0]?.count ?? 0;
	}

	test('createManagedTenant stores contact snapshot without linking existing users', async () => {
		const beforeUsers = await countUsersLike(`${fixture.runId}-%`);

		const created = await createManagedTenant(
			db,
			fixture.landlordA.actor,
			{
				displayName: 'Contact snapshot tenant',
				email: fixture.landlordA.userId + '@existing-user.test',
				phone: '0900111222'
			},
			{ requestId: 'auth009-create' }
		);

		expectNoForbiddenKeys(created);
		assert.equal(created.isClaimed, false);
		assert.equal(created.tenantId, created.id);

		const row = await db
			.select({
				claimedByUserId: managedTenants.claimedByUserId,
				emailSnapshot: managedTenants.emailSnapshot
			})
			.from(managedTenants)
			.where(eq(managedTenants.id, created.id));
		assert.equal(row[0]?.claimedByUserId, null);
		assert.equal(row[0]?.emailSnapshot, fixture.landlordA.userId + '@existing-user.test');

		const afterUsers = await countUsersLike(`${fixture.runId}-%`);
		assert.equal(afterUsers, beforeUsers, 'contact must not create users');
	});

	test('duplicate contact creates separate managed tenants', async () => {
		const first = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'Tenant A',
			email: 'dup@example.com'
		});
		const second = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'Tenant B',
			email: 'dup@example.com'
		});
		assert.notEqual(first.id, second.id);
	});

	test('issue invite binds landlord + managed tenant + active tenancy and stores hash only', async () => {
		const managed = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'Invite target'
		});
		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA2,
			managedTenantId: managed.id,
			startDate: '2026-07-01'
		});

		const issued = await issueTenantInvite(
			db,
			fixture.landlordA.actor,
			{ managedTenantId: managed.id, tenancyId: started.tenancy.id },
			{ requestId: 'auth009-issue' }
		);

		expectNoForbiddenKeys({ ...issued, token: 'redacted' });
		assert.ok(issued.token.length > 20);

		const stored = await db
			.select({
				token: tenantInvites.token,
				tokenHash: tenantInvites.tokenHash,
				status: tenantInvites.status,
				purpose: tenantInvites.purpose,
				expectedClaimVersion: tenantInvites.expectedClaimVersion
			})
			.from(tenantInvites)
			.where(eq(tenantInvites.id, issued.inviteId));

		assert.equal(stored[0]?.tokenHash, hashInviteToken(issued.token));
		assert.equal(stored[0]?.status, 'PENDING');
		assert.equal(stored[0]?.purpose, 'INITIAL_CLAIM');
		assert.equal(stored[0]?.expectedClaimVersion, 0);
		assert.notEqual(stored[0]?.token, issued.token);
	});

	test('concurrent issue keeps at most one pending invite per tenancy', async () => {
		const managed = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'Concurrent invite'
		});
		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA3,
			managedTenantId: managed.id,
			startDate: '2026-07-02'
		});

		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				issueTenantInvite(db, fixture.landlordA.actor, {
					managedTenantId: managed.id,
					tenancyId: started.tenancy.id
				})
			)
		);
		assert.equal(results.length, 10);

		const pending = await db
			.select({ id: tenantInvites.id, status: tenantInvites.status })
			.from(tenantInvites)
			.where(
				and(eq(tenantInvites.tenancyId, started.tenancy.id), eq(tenantInvites.status, 'PENDING'))
			);
		assert.equal(pending.length, 1);

		const revoked = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(tenantInvites)
			.where(
				and(eq(tenantInvites.tenancyId, started.tenancy.id), eq(tenantInvites.status, 'REVOKED'))
			);
		assert.ok((revoked[0]?.count ?? 0) >= 9);
	});

	test('accept invite claims managed tenant without starting tenancy or creating contracts', async () => {
		const managed = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'Claim target'
		});
		const started = await startTenancy(db, fixture.landlordA.actor, {
			roomId: fixture.roomA1,
			managedTenantId: managed.id,
			startDate: '2026-07-03'
		});
		const issued = await issueTenantInvite(db, fixture.landlordA.actor, {
			managedTenantId: managed.id,
			tenancyId: started.tenancy.id
		});

		const tenantUserId = `${fixture.runId}-claim-user`;
		const tenantProfileId = `${fixture.runId}-claim-profile`;
		await db.insert(users).values({
			id: tenantUserId,
			email: `${tenantUserId}@auth009.test`,
			phone: tenantUserId,
			passwordHash: 'not-a-real-hash',
			name: 'Claim user',
			role: 'TENANT',
			isActive: true
		});
		await db.insert(tenantProfiles).values({
			id: tenantProfileId,
			userId: tenantUserId
		});

		const tenancyCountBefore = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(tenancies)
			.where(eq(tenancies.landlordId, fixture.landlordA.landlordId));

		const accepted = await acceptTenantInvite(db, {
			token: issued.token,
			actorUserId: tenantUserId,
			actorTenantProfileId: tenantProfileId
		});
		assert.equal(accepted.managedTenantId, managed.id);
		assert.equal(accepted.idempotent, false);

		const claimed = await db
			.select({
				claimedByUserId: managedTenants.claimedByUserId,
				claimVersion: managedTenants.claimVersion
			})
			.from(managedTenants)
			.where(eq(managedTenants.id, managed.id));
		assert.equal(claimed[0]?.claimedByUserId, tenantUserId);
		assert.equal(claimed[0]?.claimVersion, 1);

		const tenancyCountAfter = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(tenancies)
			.where(eq(tenancies.landlordId, fixture.landlordA.landlordId));
		assert.equal(tenancyCountAfter[0]?.count, tenancyCountBefore[0]?.count);

		await assert.rejects(
			() =>
				acceptTenantInvite(db, {
					token: issued.token,
					actorUserId: tenantUserId,
					actorTenantProfileId: tenantProfileId
				}),
			(error: unknown) => isTenantInviteServiceError(error) && error.code === 'INVITE_USED'
		);
	});

	test('foreign landlord cannot issue invite for managed tenant B', async () => {
		await assert.rejects(
			() =>
				issueTenantInvite(db, fixture.landlordA.actor, {
					managedTenantId: fixture.managedTenantB,
					tenancyId: 'missing-tenancy'
				}),
			(error: unknown) =>
				isTenantInviteServiceError(error) && error.code === 'MANAGED_TENANT_NOT_FOUND'
		);
	});

	test('append audit on managed tenant create', async () => {
		const created = await createManagedTenant(db, fixture.landlordA.actor, {
			displayName: 'Audit create'
		});
		const events = await db
			.select({ action: auditEvents.action, resourceId: auditEvents.resourceId })
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.landlordId, fixture.landlordA.landlordId),
					eq(auditEvents.resourceId, created.id)
				)
			);
		assert.ok(events.some((event) => event.action === 'TENANCY.CREATED'));
	});
}
