/**
 * AUTH-009 — issue and accept INITIAL_CLAIM tenant invites.
 * Authority from scoped SQL; plaintext token returned once; hash stored only.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '$lib/server/db/schema';
import {
	contracts,
	managedTenants,
	tenantInvites,
	tenantProfiles,
	tenancies,
	users
} from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import { appendAudit, auditActorFromUserActor, type AuditTx } from '$lib/server/audit';
import { getEnv } from '$lib/server/env';
import { loadManagedTenantInScope } from '$lib/server/managed-tenants/service.js';
import { generateInviteToken, hashInviteToken } from './token.js';
import {
	inviteError,
	type AcceptTenantInviteInput,
	type AcceptTenantInviteResult,
	type IssueTenantInviteInput,
	type IssueTenantInviteResult
} from './state.js';

export type TenantInviteDb = NodePgDatabase<typeof schema>;
export type TenantInviteTx = AuditTx;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TenantInviteServiceOptions = {
	requestId?: string | null;
	now?: Date;
};

function buildDeepLink(token: string): string | null {
	const telegram = getEnv().telegram;
	if (telegram.status !== 'CONFIGURED') return null;
	return `https://t.me/${telegram.botUsername}/${telegram.miniappShortName}?startapp=${token}`;
}

/**
 * Legacy `TenantInvite.tenantId` is NOT NULL with FK to TenantProfile.
 * New-flow invites bind authority via managedTenantId + tenancyId; this anchor
 * satisfies the legacy column without using contact data to find/create Users.
 */
async function resolveLegacyTenantIdForInvite(
	tx: TenantInviteTx,
	managedTenant: {
		id: string;
		legacyTenantProfileId: string | null;
		claimedByUserId: string | null;
	}
): Promise<string> {
	if (managedTenant.legacyTenantProfileId) return managedTenant.legacyTenantProfileId;

	if (managedTenant.claimedByUserId) {
		const rows = await tx
			.select({ id: tenantProfiles.id })
			.from(tenantProfiles)
			.where(eq(tenantProfiles.userId, managedTenant.claimedByUserId))
			.limit(1);
		if (rows[0]?.id) return rows[0].id;
	}

	const anchorUserId = `invite-anchor-${managedTenant.id}`;
	const anchorProfileId = `invite-anchor-profile-${managedTenant.id}`;

	const existingProfile = await tx
		.select({ id: tenantProfiles.id })
		.from(tenantProfiles)
		.where(eq(tenantProfiles.id, anchorProfileId))
		.limit(1);
	if (existingProfile[0]?.id) return existingProfile[0].id;

	await tx.insert(users).values({
		id: anchorUserId,
		email: `${anchorUserId}@invite-anchor.invalid`,
		phone: anchorUserId,
		passwordHash: 'invite-anchor-not-a-password',
		name: 'Invite anchor',
		role: 'TENANT',
		isActive: false
	});

	await tx.insert(tenantProfiles).values({
		id: anchorProfileId,
		userId: anchorUserId
	});

	return anchorProfileId;
}

async function loadActiveTenancyForInvite(
	tx: TenantInviteTx,
	actor: LandlordActor,
	input: IssueTenantInviteInput
) {
	const rows = await tx
		.select({
			id: tenancies.id,
			landlordId: tenancies.landlordId,
			managedTenantId: tenancies.managedTenantId,
			status: tenancies.status
		})
		.from(tenancies)
		.where(
			and(
				eq(tenancies.id, input.tenancyId),
				eq(tenancies.landlordId, actor.landlordId),
				eq(tenancies.managedTenantId, input.managedTenantId),
				eq(tenancies.status, 'ACTIVE')
			)
		)
		.for('update')
		.limit(1);

	const row = rows[0];
	if (!row) {
		const exists = await tx
			.select({ id: tenancies.id })
			.from(tenancies)
			.where(and(eq(tenancies.id, input.tenancyId), eq(tenancies.landlordId, actor.landlordId)))
			.limit(1);
		if (!exists[0]) throw inviteError('TENANCY_NOT_FOUND');
		const scoped = await tx
			.select({ managedTenantId: tenancies.managedTenantId, status: tenancies.status })
			.from(tenancies)
			.where(eq(tenancies.id, input.tenancyId))
			.limit(1);
		if (scoped[0]?.managedTenantId !== input.managedTenantId) {
			throw inviteError('TENANCY_SCOPE_MISMATCH');
		}
		throw inviteError('TENANCY_NOT_ACTIVE');
	}
	return row;
}

export async function issueTenantInvite(
	conn: TenantInviteDb,
	actor: LandlordActor,
	rawInput: IssueTenantInviteInput,
	options: TenantInviteServiceOptions = {}
): Promise<IssueTenantInviteResult> {
	if (!rawInput.managedTenantId?.trim()) throw inviteError('MANAGED_TENANT_ID_REQUIRED');
	if (!rawInput.tenancyId?.trim()) throw inviteError('TENANCY_ID_REQUIRED');

	const now = options.now ?? new Date();
	const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
	const token = generateInviteToken();
	const tokenHash = hashInviteToken(token);

	return conn.transaction(async (tx) => {
		const managedTenant = await loadManagedTenantInScope(
			tx,
			actor,
			rawInput.managedTenantId.trim()
		);
		await loadActiveTenancyForInvite(tx, actor, {
			managedTenantId: managedTenant.id,
			tenancyId: rawInput.tenancyId.trim()
		});

		const legacyTenantId = await resolveLegacyTenantIdForInvite(tx, managedTenant);
		const legacyTokenPlaceholder = `revoked-${tokenHash}`;

		await tx
			.update(tenantInvites)
			.set({ status: 'REVOKED', revokedAt: now, updatedAt: now })
			.where(
				and(
					eq(tenantInvites.tenancyId, rawInput.tenancyId.trim()),
					eq(tenantInvites.status, 'PENDING')
				)
			);

		const inserted = await tx
			.insert(tenantInvites)
			.values({
				landlordId: actor.landlordId,
				tenantId: legacyTenantId,
				token: legacyTokenPlaceholder,
				tokenHash,
				expiresAt,
				managedTenantId: managedTenant.id,
				tenancyId: rawInput.tenancyId.trim(),
				status: 'PENDING',
				purpose: 'INITIAL_CLAIM',
				expectedClaimVersion: managedTenant.claimVersion,
				updatedAt: now
			})
			.returning({ id: tenantInvites.id });

		const inviteId = inserted[0]?.id;
		if (!inviteId) throw new Error('issueTenantInvite insert did not return id');

		await appendAudit(tx, auditActorFromUserActor(actor), {
			action: 'TENANCY.INVITE_CREATED',
			resourceType: 'TenantInvite',
			resourceId: inviteId,
			landlordId: actor.landlordId,
			requestId: options.requestId ?? null,
			scope: 'LANDLORD',
			metadata: {
				managedTenantId: managedTenant.id,
				tenancyId: rawInput.tenancyId.trim(),
				purpose: 'INITIAL_CLAIM'
			}
		});

		return {
			token,
			link: buildDeepLink(token),
			expiresAt: expiresAt.toISOString(),
			inviteId
		};
	});
}

type LockedInvite = {
	id: string;
	landlordId: string;
	managedTenantId: string | null;
	tenancyId: string | null;
	status: string | null;
	purpose: string | null;
	expectedClaimVersion: number | null;
	expiresAt: Date;
	usedAt: Date | null;
	revokedAt: Date | null;
	acceptedByUserId: string | null;
};

async function lockInviteByTokenHash(tx: TenantInviteTx, tokenHash: string): Promise<LockedInvite> {
	const rows = await tx
		.select({
			id: tenantInvites.id,
			landlordId: tenantInvites.landlordId,
			managedTenantId: tenantInvites.managedTenantId,
			tenancyId: tenantInvites.tenancyId,
			status: tenantInvites.status,
			purpose: tenantInvites.purpose,
			expectedClaimVersion: tenantInvites.expectedClaimVersion,
			expiresAt: tenantInvites.expiresAt,
			usedAt: tenantInvites.usedAt,
			revokedAt: tenantInvites.revokedAt,
			acceptedByUserId: tenantInvites.acceptedByUserId
		})
		.from(tenantInvites)
		.where(eq(tenantInvites.tokenHash, tokenHash))
		.for('update')
		.limit(1);

	const invite = rows[0];
	if (!invite) throw inviteError('INVITE_NOT_FOUND');
	return invite;
}

function assertInviteAcceptable(invite: LockedInvite, now: Date): void {
	if (invite.status === 'ACCEPTED' || invite.usedAt) throw inviteError('INVITE_USED');
	if (invite.status === 'REVOKED' || invite.revokedAt) throw inviteError('INVITE_REVOKED');
	if (invite.status === 'EXPIRED' || invite.expiresAt <= now) throw inviteError('INVITE_EXPIRED');
	if (invite.status !== 'PENDING') throw inviteError('INVITE_NOT_FOUND');
	if (invite.purpose !== 'INITIAL_CLAIM') throw inviteError('INVITE_NOT_FOUND');
	if (!invite.managedTenantId || !invite.tenancyId) throw inviteError('INVITE_NOT_FOUND');
}

async function countTenanciesContractsInvoices(
	tx: TenantInviteTx,
	tenancyId: string
): Promise<{ tenancies: number; contracts: number; invoices: number }> {
	const tenancyRows = await tx
		.select({ count: sql<number>`count(*)::int` })
		.from(tenancies)
		.where(eq(tenancies.id, tenancyId));
	const contractRows = await tx
		.select({ count: sql<number>`count(*)::int` })
		.from(contracts)
		.where(eq(contracts.tenancyId, tenancyId));
	return {
		tenancies: tenancyRows[0]?.count ?? 0,
		contracts: contractRows[0]?.count ?? 0,
		invoices: 0
	};
}

export async function acceptTenantInvite(
	conn: TenantInviteDb,
	input: AcceptTenantInviteInput,
	options: TenantInviteServiceOptions = {}
): Promise<AcceptTenantInviteResult> {
	if (!input.actorUserId?.trim() || !input.actorTenantProfileId?.trim()) {
		throw inviteError('IDENTITY_REQUIRED');
	}

	const now = options.now ?? new Date();
	const tokenHash = hashInviteToken(input.token);

	return conn.transaction(async (tx) => {
		const invite = await lockInviteByTokenHash(tx, tokenHash);

		if (
			invite.status === 'ACCEPTED' &&
			invite.acceptedByUserId === input.actorUserId &&
			invite.usedAt &&
			invite.managedTenantId &&
			invite.tenancyId
		) {
			return {
				managedTenantId: invite.managedTenantId,
				tenancyId: invite.tenancyId,
				claimedByUserId: input.actorUserId,
				idempotent: true
			};
		}

		assertInviteAcceptable(invite, now);

		const managedTenantRows = await tx
			.select({
				id: managedTenants.id,
				claimedByUserId: managedTenants.claimedByUserId,
				claimVersion: managedTenants.claimVersion,
				status: managedTenants.status
			})
			.from(managedTenants)
			.where(eq(managedTenants.id, invite.managedTenantId!))
			.for('update')
			.limit(1);

		const managedTenant = managedTenantRows[0];
		if (!managedTenant || managedTenant.status === 'ARCHIVED') {
			throw inviteError('MANAGED_TENANT_NOT_FOUND');
		}

		const tenancyRows = await tx
			.select({
				id: tenancies.id,
				status: tenancies.status,
				managedTenantId: tenancies.managedTenantId
			})
			.from(tenancies)
			.where(eq(tenancies.id, invite.tenancyId!))
			.for('update')
			.limit(1);

		const tenancy = tenancyRows[0];
		if (!tenancy || tenancy.managedTenantId !== invite.managedTenantId) {
			throw inviteError('TENANCY_SCOPE_MISMATCH');
		}
		if (tenancy.status !== 'ACTIVE') throw inviteError('TENANCY_NOT_ACTIVE');

		if (invite.expectedClaimVersion !== managedTenant.claimVersion) {
			throw inviteError('INVITE_STALE_CLAIM_VERSION');
		}

		if (input.telegramUserId) {
			const linked = await tx
				.select({ id: tenantProfiles.id, userId: tenantProfiles.userId })
				.from(tenantProfiles)
				.where(eq(tenantProfiles.telegramUserId, input.telegramUserId))
				.limit(1);
			if (linked[0] && linked[0].userId !== input.actorUserId) {
				throw inviteError('TELEGRAM_ALREADY_LINKED');
			}
		}

		const tenancyBefore = await countTenanciesContractsInvoices(tx, invite.tenancyId!);

		let idempotent = false;

		if (managedTenant.claimedByUserId === null) {
			const claimed = await tx
				.update(managedTenants)
				.set({
					claimedByUserId: input.actorUserId,
					claimVersion: sql`${managedTenants.claimVersion} + 1`,
					updatedAt: now
				})
				.where(
					and(
						eq(managedTenants.id, managedTenant.id),
						sql`${managedTenants.claimedByUserId} IS NULL`,
						eq(managedTenants.claimVersion, invite.expectedClaimVersion ?? 0)
					)
				)
				.returning({ id: managedTenants.id });

			if (claimed.length === 0) {
				const current = await tx
					.select({ claimedByUserId: managedTenants.claimedByUserId })
					.from(managedTenants)
					.where(eq(managedTenants.id, managedTenant.id))
					.limit(1);
				if (current[0]?.claimedByUserId === input.actorUserId) {
					idempotent = true;
				} else {
					throw inviteError('MANAGED_TENANT_ALREADY_CLAIMED');
				}
			}
		} else if (managedTenant.claimedByUserId === input.actorUserId) {
			idempotent = true;
		} else {
			throw inviteError('MANAGED_TENANT_ALREADY_CLAIMED');
		}

		if (input.telegramUserId) {
			const profileRows = await tx
				.select({ id: tenantProfiles.id, telegramUserId: tenantProfiles.telegramUserId })
				.from(tenantProfiles)
				.where(eq(tenantProfiles.id, input.actorTenantProfileId))
				.for('update')
				.limit(1);
			const profile = profileRows[0];
			if (!profile) throw inviteError('IDENTITY_REQUIRED');
			if (profile.telegramUserId && profile.telegramUserId !== input.telegramUserId) {
				throw inviteError('TELEGRAM_ALREADY_LINKED');
			}
			if (!profile.telegramUserId) {
				await tx
					.update(tenantProfiles)
					.set({ telegramUserId: input.telegramUserId })
					.where(eq(tenantProfiles.id, profile.id));
			}
		}

		if (!idempotent) {
			const accepted = await tx
				.update(tenantInvites)
				.set({
					status: 'ACCEPTED',
					usedAt: now,
					acceptedByUserId: input.actorUserId,
					updatedAt: now
				})
				.where(
					and(
						eq(tenantInvites.id, invite.id),
						eq(tenantInvites.status, 'PENDING'),
						sql`"usedAt" IS NULL`
					)
				)
				.returning({ id: tenantInvites.id });

			if (accepted.length === 0) throw inviteError('INVITE_CONFLICT');

			await appendAudit(
				tx,
				auditActorFromUserActor(
					{
						kind: 'USER',
						userId: input.actorUserId,
						role: 'TENANT',
						tenantProfileId: input.actorTenantProfileId
					},
					invite.landlordId
				),
				{
					action: 'TENANCY.INVITE_ACCEPTED',
					resourceType: 'ManagedTenant',
					resourceId: invite.managedTenantId!,
					landlordId: invite.landlordId,
					requestId: options.requestId ?? null,
					scope: 'LANDLORD',
					metadata: {
						tenancyId: invite.tenancyId!,
						inviteId: invite.id
					}
				}
			);
		}

		const tenancyAfter = await countTenanciesContractsInvoices(tx, invite.tenancyId!);
		if (
			tenancyBefore.tenancies !== tenancyAfter.tenancies ||
			tenancyBefore.contracts !== tenancyAfter.contracts
		) {
			throw new Error('acceptTenantInvite mutated tenancy/contract counts');
		}

		return {
			managedTenantId: invite.managedTenantId!,
			tenancyId: invite.tenancyId!,
			claimedByUserId: input.actorUserId,
			idempotent
		};
	});
}
