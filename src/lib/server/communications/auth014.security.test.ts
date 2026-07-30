import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import {
	announcements,
	conversations,
	managedTenants,
	messages,
	notificationQueue,
	specialNotes,
	tenancies
} from '../db/schema.js';
import type { LandlordActor, TenantActor } from '../authorization/actor.js';
import { createDrizzleActorDb, getUserActor } from '../authorization/load-user-actor.js';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import {
	createAnnouncementForLandlord,
	listAnnouncementsForTenant
} from '../communications/announcements.js';
import {
	findOrCreateConversationForLandlord,
	resolveConversationForTenant
} from '../communications/conversations.js';
import {
	listMessagesForConversation,
	listMessagesForLandlord,
	listMessagesForTenant,
	sendMessageForLandlord,
	sendMessageForTenant
} from '../communications/messages.js';
import {
	assertNotificationRecipientScoped,
	createSpecialNoteForActor
} from '../communications/notifications.js';
import { sendQueuedTelegramNotification } from '../message-delivery.js';
import {
	fixtureSession,
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

type Auth014Extension = {
	managedTenantANow: string;
	managedTenantAOld: string;
	managedTenantBNow: string;
	tenancyANowActive: string;
	tenancyAOldEnded: string;
	tenancyBNowActive: string;
	announcementAAll: string;
	announcementBAll: string;
	conversationANow: string;
	conversationBNow: string;
	legacyUnresolvedConversationId: string;
};

async function seedAuth014Extensions(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<Auth014Extension> {
	const { ids } = fixture;
	const db = handle.db;

	const managedTenantANow = crypto.randomUUID();
	const managedTenantAOld = crypto.randomUUID();
	const managedTenantBNow = crypto.randomUUID();
	const tenancyANowActive = crypto.randomUUID();
	const tenancyAOldEnded = crypto.randomUUID();
	const tenancyBNowActive = crypto.randomUUID();
	const announcementAAll = crypto.randomUUID();
	const announcementBAll = crypto.randomUUID();
	const conversationANow = crypto.randomUUID();
	const conversationBNow = crypto.randomUUID();
	const legacyUnresolvedConversationId = `${ids.landlordA.landlordProfileId}_${crypto.randomUUID()}`;

	await db.insert(managedTenants).values([
		{
			id: managedTenantANow,
			landlordId: ids.landlordA.landlordProfileId,
			displayName: 'AUTH-014 tenant now',
			claimedByUserId: ids.tenantANow.userId,
			legacyTenantProfileId: ids.tenantANow.tenantProfileId,
			backfillSource: 'LEGACY_TENANT_PROFILE'
		},
		{
			id: managedTenantAOld,
			landlordId: ids.landlordA.landlordProfileId,
			displayName: 'AUTH-014 tenant old',
			claimedByUserId: ids.tenantAOld.userId,
			legacyTenantProfileId: ids.tenantAOld.tenantProfileId,
			backfillSource: 'LEGACY_TENANT_PROFILE'
		},
		{
			id: managedTenantBNow,
			landlordId: ids.landlordB.landlordProfileId,
			displayName: 'AUTH-014 tenant B',
			claimedByUserId: ids.tenantBNow.userId,
			legacyTenantProfileId: ids.tenantBNow.tenantProfileId,
			backfillSource: 'LEGACY_TENANT_PROFILE'
		}
	]);

	await db.insert(tenancies).values([
		{
			id: tenancyANowActive,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			roomId: ids.roomA1R1.roomId,
			managedTenantId: managedTenantANow,
			status: 'ACTIVE',
			startDate: '2026-01-01',
			plannedEndDate: '2026-12-31'
		},
		{
			id: tenancyAOldEnded,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			roomId: ids.roomA1R1.roomId,
			managedTenantId: managedTenantAOld,
			status: 'ENDED',
			startDate: '2025-01-01',
			endDate: '2025-12-31'
		},
		{
			id: tenancyBNowActive,
			landlordId: ids.landlordB.landlordProfileId,
			propertyId: ids.propertyB1.propertyId,
			roomId: ids.roomB1R1.roomId,
			managedTenantId: managedTenantBNow,
			status: 'ACTIVE',
			startDate: '2026-01-01',
			plannedEndDate: '2026-12-31'
		}
	]);

	await db.insert(announcements).values([
		{
			id: announcementAAll,
			landlordId: ids.landlordA.landlordProfileId,
			senderId: ids.landlordA.userId,
			title: 'A ALL',
			content: 'Landlord A broadcast',
			targetType: 'ALL',
			targetId: null
		},
		{
			id: announcementBAll,
			landlordId: ids.landlordB.landlordProfileId,
			senderId: ids.landlordB.userId,
			title: 'B ALL',
			content: 'Landlord B broadcast',
			targetType: 'ALL',
			targetId: null
		}
	]);

	await db.insert(conversations).values([
		{
			id: conversationANow,
			landlordId: ids.landlordA.landlordProfileId,
			managedTenantId: managedTenantANow,
			tenancyId: tenancyANowActive,
			legacyConversationId: `${ids.landlordA.landlordProfileId}_${ids.tenantANow.tenantProfileId}`
		},
		{
			id: conversationBNow,
			landlordId: ids.landlordB.landlordProfileId,
			managedTenantId: managedTenantBNow,
			tenancyId: tenancyBNowActive,
			legacyConversationId: `${ids.landlordB.landlordProfileId}_${ids.tenantBNow.tenantProfileId}`
		}
	]);

	await db.insert(messages).values([
		{
			id: crypto.randomUUID(),
			conversationId: conversationANow,
			senderId: ids.landlordA.userId,
			content: 'scoped A now'
		},
		{
			id: crypto.randomUUID(),
			conversationId: legacyUnresolvedConversationId,
			senderId: ids.landlordA.userId,
			content: 'legacy unresolved'
		}
	]);

	return {
		managedTenantANow,
		managedTenantAOld,
		managedTenantBNow,
		tenancyANowActive,
		tenancyAOldEnded,
		tenancyBNowActive,
		announcementAAll,
		announcementBAll,
		conversationANow,
		conversationBNow,
		legacyUnresolvedConversationId
	};
}

async function actorFromSession(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap,
	who: Parameters<typeof fixtureSession>[1]
) {
	return getUserActor(fixtureSession(fixture, who), createDrizzleActorDb(handle.db));
}

if (skipReason) {
	test('AUTH-014 communications security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('AUTH-014 communications security suite', async (t) => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const ext = await seedAuth014Extensions(handle, fixture);
			const ids = fixture.ids;
			const db = handle.db;

			const landlordA = (await actorFromSession(handle, fixture, 'landlordA')) as LandlordActor;
			const landlordB = (await actorFromSession(handle, fixture, 'landlordB')) as LandlordActor;
			const tenantANow = (await actorFromSession(handle, fixture, 'tenantANow')) as TenantActor;
			const tenantAOld = (await actorFromSession(handle, fixture, 'tenantAOld')) as TenantActor;
			const tenantBNow = (await actorFromSession(handle, fixture, 'tenantBNow')) as TenantActor;

			await t.test('global ALL announcement does not leak across landlords', async () => {
				const rows = await listAnnouncementsForTenant(db, tenantANow);
				const announcementIds = rows.map((row) => row.id);
				assert.ok(announcementIds.includes(ext.announcementAAll));
				assert.ok(!announcementIds.includes(ext.announcementBAll));
			});

			await t.test('tenant B cannot see landlord A ALL announcements', async () => {
				const rows = await listAnnouncementsForTenant(db, tenantBNow);
				assert.ok(!rows.some((row) => row.id === ext.announcementAAll));
			});

			await t.test('landlord B cannot list landlord A conversation messages', async () => {
				await assert.rejects(
					() =>
						listMessagesForLandlord(db, landlordB, {
							conversationId: ext.conversationANow
						}),
					(err: Error) => err.message === 'Không tìm thấy'
				);
			});

			await t.test('tenant cannot access forged landlord B conversation', async () => {
				await assert.rejects(
					() =>
						resolveConversationForTenant(db, tenantANow, {
							conversationId: ext.conversationBNow
						}),
					(err: Error) => err.message === 'Không tìm thấy'
				);
			});

			await t.test('legacy unresolved conversation is hidden from tenant', async () => {
				await assert.rejects(
					() =>
						listMessagesForTenant(db, tenantANow, {
							conversationId: ext.legacyUnresolvedConversationId
						}),
					(err: Error) => err.message === 'Không tìm thấy'
				);
			});

			await t.test('sender is server-controlled, not taken from request body', async () => {
				const { message } = await sendMessageForTenant(db, tenantANow, {
					conversationId: ext.conversationANow,
					content: 'tenant reply'
				});
				assert.equal(message.senderId, ids.tenantANow.userId);
				assert.notEqual(message.senderId, ids.landlordA.userId);
			});

			await t.test('old tenant cannot read current tenant conversation', async () => {
				await assert.rejects(
					() =>
						listMessagesForTenant(db, tenantAOld, {
							conversationId: ext.conversationANow
						}),
					(err: Error) => err.message === 'Không tìm thấy'
				);
			});

			await t.test('cursor pagination stays within scoped conversation', async () => {
				const first = await sendMessageForLandlord(db, landlordA, {
					managedTenantId: ext.managedTenantANow,
					content: 'cursor-1'
				});
				const second = await sendMessageForLandlord(db, landlordA, {
					managedTenantId: ext.managedTenantANow,
					content: 'cursor-2'
				});
				const conversation = await findOrCreateConversationForLandlord(db, landlordA, {
					managedTenantId: ext.managedTenantANow
				});
				const paged = await listMessagesForConversation(db, conversation, {
					cursor: second.message.id,
					limit: 10
				});
				const idsInPage = paged.map((row) => row.id);
				assert.ok(idsInPage.includes(first.message.id));
				assert.ok(!idsInPage.includes(second.message.id));
			});

			await t.test('notification related resource mismatch fails closed', async () => {
				const [badNotification] = await db
					.insert(notificationQueue)
					.values({
						landlordId: ids.landlordA.landlordProfileId,
						tenantId: ids.tenantANow.tenantProfileId,
						recipientUserId: ids.tenantANow.userId,
						type: 'announcement',
						channel: 'telegram',
						title: 'cross landlord',
						content: 'should fail',
						status: 'queued',
						relatedType: 'announcement',
						relatedId: ext.announcementBAll,
						scheduledFor: '2026-07-30'
					})
					.returning();

				await assert.rejects(
					() => assertNotificationRecipientScoped(db, badNotification),
					(err: Error) => err.message === 'Không tìm thấy'
				);

				const delivery = await sendQueuedTelegramNotification(badNotification);
				assert.equal(delivery.status, 'failed');
				if (delivery.status === 'failed') {
					assert.equal(delivery.retryable, false);
				}
			});

			await t.test('landlord creates announcement with landlordId scope only', async () => {
				const created = await createAnnouncementForLandlord(db, landlordA, {
					title: 'scoped create',
					content: 'only A tenants',
					targetType: 'ALL'
				});
				assert.equal(created.landlordId, ids.landlordA.landlordProfileId);
				expectNoForbiddenKeys(created);
			});

			await t.test('special note recipient stays within landlord tenancy', async () => {
				const note = await createSpecialNoteForActor(db, tenantANow, {
					tenancyId: ext.tenancyANowActive,
					content: 'tenant note'
				});
				assert.equal(note.landlordId, ids.landlordA.landlordProfileId);
				assert.equal(note.managedTenantId, ext.managedTenantANow);

				const landlordNotes = await db.query.specialNotes.findMany({
					where: eq(specialNotes.landlordId, ids.landlordB.landlordProfileId)
				});
				assert.ok(!landlordNotes.some((row) => row.id === note.id));
			});
		});
	});
}
