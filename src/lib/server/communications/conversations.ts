import { and, eq, isNull } from 'drizzle-orm';
import { conversations, managedTenants, tenancies } from '$lib/server/db/schema';
import type { LandlordActor, StaffActor, TenantActor } from '$lib/server/authorization/actor';
import { forbiddenError } from '$lib/server/authorization/errors';
import { staffHasPermission } from '$lib/server/authorization/staff-scope';
import { resolveTenancyForTenantMutation } from '$lib/server/operations/active-tenancy';
import {
	communicationsNotFound,
	communicationsValidation,
	type CommunicationsDb
} from './errors.js';

export type ConversationRow = typeof conversations.$inferSelect;

export type ResolvedConversation = ConversationRow & {
	messageConversationIds: string[];
};

function legacyConversationId(landlordId: string, legacyTenantProfileId: string) {
	return `${landlordId}_${legacyTenantProfileId}`;
}

function messageIdsForConversation(conversation: ConversationRow): string[] {
	const ids = [conversation.id];
	if (conversation.legacyConversationId && conversation.legacyConversationId !== conversation.id) {
		ids.push(conversation.legacyConversationId);
	}
	return ids;
}

async function findManagedTenantForLandlord(
	database: CommunicationsDb,
	landlordId: string,
	managedTenantId: string
) {
	const row = await database.query.managedTenants.findFirst({
		where: and(eq(managedTenants.id, managedTenantId), eq(managedTenants.landlordId, landlordId)),
		columns: { id: true, legacyTenantProfileId: true }
	});
	if (!row) throw communicationsNotFound();
	return row;
}

async function resolveTenancyId(
	database: CommunicationsDb,
	landlordId: string,
	managedTenantId: string,
	tenancyId?: string | null
) {
	if (tenancyId) {
		const row = await database.query.tenancies.findFirst({
			where: and(
				eq(tenancies.id, tenancyId),
				eq(tenancies.landlordId, landlordId),
				eq(tenancies.managedTenantId, managedTenantId)
			),
			columns: { id: true }
		});
		if (!row) throw communicationsNotFound();
		return row.id;
	}

	const active = await database.query.tenancies.findFirst({
		where: and(
			eq(tenancies.managedTenantId, managedTenantId),
			eq(tenancies.landlordId, landlordId),
			eq(tenancies.status, 'ACTIVE')
		),
		columns: { id: true }
	});
	return active?.id ?? null;
}

export async function findOrCreateConversationForLandlord(
	database: CommunicationsDb,
	actor: LandlordActor,
	input: { managedTenantId: string; tenancyId?: string | null }
): Promise<ResolvedConversation> {
	const managedTenant = await findManagedTenantForLandlord(
		database,
		actor.landlordId,
		input.managedTenantId
	);
	const tenancyId = await resolveTenancyId(
		database,
		actor.landlordId,
		managedTenant.id,
		input.tenancyId
	);

	const existing = await database.query.conversations.findFirst({
		where: and(
			eq(conversations.landlordId, actor.landlordId),
			eq(conversations.managedTenantId, managedTenant.id),
			tenancyId ? eq(conversations.tenancyId, tenancyId) : isNull(conversations.tenancyId)
		)
	});
	if (existing) {
		return { ...existing, messageConversationIds: messageIdsForConversation(existing) };
	}

	const legacyId = managedTenant.legacyTenantProfileId
		? legacyConversationId(actor.landlordId, managedTenant.legacyTenantProfileId)
		: null;

	const [created] = await database
		.insert(conversations)
		.values({
			landlordId: actor.landlordId,
			managedTenantId: managedTenant.id,
			tenancyId,
			legacyConversationId: legacyId
		})
		.returning();

	return { ...created, messageConversationIds: messageIdsForConversation(created) };
}

export async function findOrCreateConversationForStaff(
	database: CommunicationsDb,
	actor: StaffActor,
	input: { managedTenantId: string; tenancyId?: string | null }
): Promise<ResolvedConversation> {
	if (!staffHasPermission(actor, 'VIEW_TENANTS')) {
		throw forbiddenError();
	}
	return findOrCreateConversationForLandlord(
		database,
		{ kind: 'USER', role: 'LANDLORD', userId: actor.userId, landlordId: actor.landlordId },
		input
	);
}

export async function resolveConversationForTenant(
	database: CommunicationsDb,
	actor: TenantActor,
	input: {
		conversationId?: string | null;
		managedTenantId?: string | null;
		tenancyId?: string | null;
	}
): Promise<ResolvedConversation> {
	const conversationId =
		typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
	const managedTenantId =
		typeof input.managedTenantId === 'string' ? input.managedTenantId.trim() : '';
	const tenancyId = typeof input.tenancyId === 'string' ? input.tenancyId.trim() : '';

	if (conversationId) {
		const row = await database.query.conversations.findFirst({
			where: eq(conversations.id, conversationId),
			with: {
				managedTenant: {
					columns: { claimedByUserId: true, claimAccessSuspendedAt: true }
				}
			}
		});
		if (
			!row ||
			row.managedTenant.claimedByUserId !== actor.userId ||
			row.managedTenant.claimAccessSuspendedAt
		) {
			throw communicationsNotFound();
		}
		return { ...row, messageConversationIds: messageIdsForConversation(row) };
	}

	if (!managedTenantId && !tenancyId) {
		throw communicationsValidation('Cần conversationId hoặc managedTenantId/tenancyId');
	}

	if (tenancyId) {
		const tenancy = await resolveTenancyForTenantMutation(database, actor, { tenancyId });
		const row = await database.query.conversations.findFirst({
			where: and(
				eq(conversations.landlordId, tenancy.landlordId),
				eq(conversations.managedTenantId, tenancy.managedTenantId),
				eq(conversations.tenancyId, tenancy.tenancyId)
			)
		});
		if (!row) throw communicationsNotFound();
		return { ...row, messageConversationIds: messageIdsForConversation(row) };
	}

	const managedTenant = await database.query.managedTenants.findFirst({
		where: and(
			eq(managedTenants.id, managedTenantId),
			eq(managedTenants.claimedByUserId, actor.userId),
			isNull(managedTenants.claimAccessSuspendedAt)
		),
		columns: { id: true, landlordId: true }
	});
	if (!managedTenant) throw communicationsNotFound();

	const row = await database.query.conversations.findFirst({
		where: and(
			eq(conversations.landlordId, managedTenant.landlordId),
			eq(conversations.managedTenantId, managedTenant.id)
		)
	});
	if (!row) throw communicationsNotFound();
	return { ...row, messageConversationIds: messageIdsForConversation(row) };
}

export async function resolveConversationForLandlordSide(
	database: CommunicationsDb,
	actor: LandlordActor | StaffActor,
	input: {
		conversationId?: string | null;
		managedTenantId?: string | null;
		legacyTenantProfileId?: string | null;
		tenancyId?: string | null;
	}
): Promise<ResolvedConversation> {
	const landlordId = actor.landlordId;
	const conversationId =
		typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
	const managedTenantId =
		typeof input.managedTenantId === 'string' ? input.managedTenantId.trim() : '';
	const legacyTenantProfileId =
		typeof input.legacyTenantProfileId === 'string' ? input.legacyTenantProfileId.trim() : '';

	if (conversationId) {
		const row = await database.query.conversations.findFirst({
			where: and(eq(conversations.id, conversationId), eq(conversations.landlordId, landlordId))
		});
		if (!row) throw communicationsNotFound();
		return { ...row, messageConversationIds: messageIdsForConversation(row) };
	}

	if (managedTenantId) {
		return findOrCreateConversationForLandlord(database, actor as LandlordActor, {
			managedTenantId,
			tenancyId: input.tenancyId
		});
	}

	if (legacyTenantProfileId) {
		const managedTenant = await database.query.managedTenants.findFirst({
			where: and(
				eq(managedTenants.landlordId, landlordId),
				eq(managedTenants.legacyTenantProfileId, legacyTenantProfileId)
			),
			columns: { id: true }
		});
		if (!managedTenant) throw communicationsNotFound();
		return findOrCreateConversationForLandlord(database, actor as LandlordActor, {
			managedTenantId: managedTenant.id,
			tenancyId: input.tenancyId
		});
	}

	throw communicationsValidation('Cần conversationId hoặc managedTenantId');
}
