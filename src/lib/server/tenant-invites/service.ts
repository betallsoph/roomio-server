/**
 * AUTH-009 — issue and accept INITIAL_CLAIM tenant invites.
 * Authority from scoped SQL; plaintext token returned once; hash stored only.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '$lib/server/db/schema';
import {
	contracts,
	invoices,
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

export type ClaimTenantInviteViaTelegramInput = {
	token: string;
	telegramUserId: string;
	displayName: string;
};

export type ClaimTenantInviteViaTelegramResult = AcceptTenantInviteResult & {
	userId: string;
	tenantProfileId: string;
};

function buildDeepLink(token: string): string | null {
	const telegram = getEnv().telegram;
	if (telegram.status !== 'CONFIGURED') return null;
	return `https://t.me/${telegram.botUsername}/${telegram.miniappShortName}?startapp=${token}`;
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

async function revokePendingInvitesForTenancy(
	tx: TenantInviteTx,
	actor: LandlordActor,
	tenancyId: string,
	now: Date,
	requestId: string | null
): Promise<void> {
	const pending = await tx
		.select({ id: tenantInvites.id, managedTenantId: tenantInvites.managedTenantId })
		.from(tenantInvites)
		.where(and(eq(tenantInvites.tenancyId, tenancyId), eq(tenantInvites.status, 'PENDING')));

	if (pending.length === 0) return;

	await tx
		.update(tenantInvites)
		.set({ status: 'REVOKED', revokedAt: now, updatedAt: now })
		.where(and(eq(tenantInvites.tenancyId, tenancyId), eq(tenantInvites.status, 'PENDING')));

	for (const invite of pending) {
		await appendAudit(tx, auditActorFromUserActor(actor), {
			action: 'TENANCY.INVITE_REVOKED',
			resourceType: 'TenantInvite',
			resourceId: invite.id,
			landlordId: actor.landlordId,
			requestId,
			scope: 'LANDLORD',
			metadata: {
				tenancyId,
				managedTenantId: invite.managedTenantId,
				reason: 'REISSUED'
			}
		});
	}
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
		if (managedTenant.claimedByUserId !== null) {
			throw inviteError('MANAGED_TENANT_ALREADY_CLAIMED');
		}
		await loadActiveTenancyForInvite(tx, actor, {
			managedTenantId: managedTenant.id,
			tenancyId: rawInput.tenancyId.trim()
		});

		await revokePendingInvitesForTenancy(
			tx,
			actor,
			rawInput.tenancyId.trim(),
			now,
			options.requestId ?? null
		);

		const inserted = await tx
			.insert(tenantInvites)
			.values({
				landlordId: actor.landlordId,
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

function claimVersionAfterAccept(expectedClaimVersion: number | null): number {
	return (expectedClaimVersion ?? 0) + 1;
}

async function loadActorTenantProfile(
	tx: TenantInviteTx,
	actorUserId: string,
	actorTenantProfileId: string
) {
	const rows = await tx
		.select({
			id: tenantProfiles.id,
			userId: tenantProfiles.userId,
			telegramUserId: tenantProfiles.telegramUserId
		})
		.from(tenantProfiles)
		.where(eq(tenantProfiles.id, actorTenantProfileId))
		.for('update')
		.limit(1);

	const profile = rows[0];
	if (!profile || profile.userId !== actorUserId) throw inviteError('IDENTITY_REQUIRED');
	return profile;
}

async function assertActiveTenantActor(
	tx: TenantInviteTx,
	actorUserId: string,
	actorTenantProfileId: string
) {
	const profile = await loadActorTenantProfile(tx, actorUserId, actorTenantProfileId);
	const userRows = await tx
		.select({ isActive: users.isActive, role: users.role })
		.from(users)
		.where(eq(users.id, actorUserId))
		.limit(1);
	const user = userRows[0];
	if (!user?.isActive || user.role !== 'TENANT') {
		throw inviteError('IDENTITY_REQUIRED');
	}
	return profile;
}

function assertAcceptLandlordBinding(
	invite: LockedInvite,
	managedTenant: { landlordId: string },
	tenancy: { landlordId: string }
): void {
	if (invite.landlordId !== managedTenant.landlordId || invite.landlordId !== tenancy.landlordId) {
		throw inviteError('TENANCY_SCOPE_MISMATCH');
	}
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
	const invoiceRows = await tx
		.select({ count: sql<number>`count(*)::int` })
		.from(invoices)
		.where(eq(invoices.tenancyId, tenancyId));
	return {
		tenancies: tenancyRows[0]?.count ?? 0,
		contracts: contractRows[0]?.count ?? 0,
		invoices: invoiceRows[0]?.count ?? 0
	};
}

type ReloadedAcceptState = {
	managedTenant: {
		id: string;
		landlordId: string;
		claimedByUserId: string | null;
		claimVersion: number;
		status: string;
	};
	tenancy: {
		id: string;
		landlordId: string;
		status: string;
		managedTenantId: string | null;
	};
	invite: LockedInvite;
};

async function reloadAcceptState(
	tx: TenantInviteTx,
	inviteId: string,
	managedTenantId: string,
	tenancyId: string
): Promise<ReloadedAcceptState | null> {
	const inviteRows = await tx
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
		.where(eq(tenantInvites.id, inviteId))
		.limit(1);

	const invite = inviteRows[0];
	if (!invite?.managedTenantId || !invite.tenancyId) return null;

	const managedTenantRows = await tx
		.select({
			id: managedTenants.id,
			landlordId: managedTenants.landlordId,
			claimedByUserId: managedTenants.claimedByUserId,
			claimVersion: managedTenants.claimVersion,
			status: managedTenants.status
		})
		.from(managedTenants)
		.where(eq(managedTenants.id, managedTenantId))
		.limit(1);

	const managedTenant = managedTenantRows[0];
	if (!managedTenant || managedTenant.status === 'ARCHIVED') return null;

	const tenancyRows = await tx
		.select({
			id: tenancies.id,
			landlordId: tenancies.landlordId,
			status: tenancies.status,
			managedTenantId: tenancies.managedTenantId
		})
		.from(tenancies)
		.where(eq(tenancies.id, tenancyId))
		.limit(1);

	const tenancy = tenancyRows[0];
	if (!tenancy || tenancy.managedTenantId !== managedTenantId || tenancy.status !== 'ACTIVE') {
		return null;
	}

	return { managedTenant, tenancy, invite };
}

async function tryIdempotentAcceptReplay(
	tx: TenantInviteTx,
	invite: LockedInvite,
	actorUserId: string,
	actorTenantProfileId: string,
	now: Date
): Promise<AcceptTenantInviteResult | null> {
	if (
		invite.status !== 'ACCEPTED' ||
		!invite.usedAt ||
		invite.acceptedByUserId !== actorUserId ||
		!invite.managedTenantId ||
		!invite.tenancyId
	) {
		return null;
	}

	await assertActiveTenantActor(tx, actorUserId, actorTenantProfileId);

	const reloaded = await reloadAcceptState(tx, invite.id, invite.managedTenantId, invite.tenancyId);
	if (!reloaded) throw inviteError('INVITE_CONFLICT');

	if (reloaded.managedTenant.claimedByUserId !== actorUserId) {
		throw inviteError('MANAGED_TENANT_ALREADY_CLAIMED');
	}
	if (
		reloaded.managedTenant.claimVersion !==
		claimVersionAfterAccept(reloaded.invite.expectedClaimVersion)
	) {
		throw inviteError('INVITE_STALE_CLAIM_VERSION');
	}
	assertAcceptLandlordBinding(reloaded.invite, reloaded.managedTenant, reloaded.tenancy);
	if (reloaded.invite.expiresAt <= now) throw inviteError('INVITE_EXPIRED');

	return {
		managedTenantId: invite.managedTenantId,
		tenancyId: invite.tenancyId,
		claimedByUserId: actorUserId,
		idempotent: true
	};
}

async function markInviteAccepted(
	tx: TenantInviteTx,
	invite: LockedInvite,
	actorUserId: string,
	now: Date
): Promise<void> {
	const accepted = await tx
		.update(tenantInvites)
		.set({
			status: 'ACCEPTED',
			usedAt: now,
			acceptedByUserId: actorUserId,
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
}

async function ensureTelegramIdentityInTx(
	tx: TenantInviteTx,
	telegramUserId: string,
	displayName: string
): Promise<{ userId: string; tenantProfileId: string }> {
	const linked = await tx
		.select({
			profileId: tenantProfiles.id,
			userId: tenantProfiles.userId
		})
		.from(tenantProfiles)
		.innerJoin(users, eq(tenantProfiles.userId, users.id))
		.where(eq(tenantProfiles.telegramUserId, telegramUserId))
		.limit(1);

	if (linked[0]) {
		const userRows = await tx
			.select({ isActive: users.isActive, role: users.role })
			.from(users)
			.where(eq(users.id, linked[0].userId))
			.limit(1);
		const user = userRows[0];
		if (!user?.isActive || user.role !== 'TENANT') {
			throw inviteError('IDENTITY_REQUIRED');
		}
		return { userId: linked[0].userId, tenantProfileId: linked[0].profileId };
	}

	const userId = `tg-${telegramUserId}`;
	const profileId = `tg-profile-${telegramUserId}`;

	const existingUser = await tx
		.select({ id: users.id, isActive: users.isActive, role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (existingUser[0]) {
		if (!existingUser[0].isActive || existingUser[0].role !== 'TENANT') {
			throw inviteError('IDENTITY_REQUIRED');
		}
	} else {
		await tx.insert(users).values({
			id: userId,
			name: displayName,
			role: 'TENANT',
			isActive: true
		});
	}

	const existingProfile = await tx
		.select({ id: tenantProfiles.id, telegramUserId: tenantProfiles.telegramUserId })
		.from(tenantProfiles)
		.where(eq(tenantProfiles.id, profileId))
		.limit(1);

	if (!existingProfile[0]) {
		await tx.insert(tenantProfiles).values({
			id: profileId,
			userId,
			telegramUserId
		});
	} else if (!existingProfile[0].telegramUserId) {
		await tx.update(tenantProfiles).set({ telegramUserId }).where(eq(tenantProfiles.id, profileId));
	}

	return { userId, tenantProfileId: profileId };
}

async function performManagedTenantClaim(
	tx: TenantInviteTx,
	input: {
		managedTenant: ReloadedAcceptState['managedTenant'];
		invite: LockedInvite;
		actorUserId: string;
		actorTenantProfileId: string;
		telegramUserId?: string | null;
		now: Date;
		requestId: string | null;
	}
): Promise<boolean> {
	const {
		managedTenant,
		invite,
		actorUserId,
		actorTenantProfileId,
		telegramUserId,
		now,
		requestId
	} = input;

	if (invite.expectedClaimVersion !== managedTenant.claimVersion) {
		throw inviteError('INVITE_STALE_CLAIM_VERSION');
	}

	if (telegramUserId) {
		const linked = await tx
			.select({ id: tenantProfiles.id, userId: tenantProfiles.userId })
			.from(tenantProfiles)
			.where(eq(tenantProfiles.telegramUserId, telegramUserId))
			.limit(1);
		if (linked[0] && linked[0].userId !== actorUserId) {
			throw inviteError('TELEGRAM_ALREADY_LINKED');
		}
	}

	const profile = await assertActiveTenantActor(tx, actorUserId, actorTenantProfileId);

	if (telegramUserId) {
		if (profile.telegramUserId && profile.telegramUserId !== telegramUserId) {
			throw inviteError('TELEGRAM_ALREADY_LINKED');
		}
		if (!profile.telegramUserId) {
			await tx
				.update(tenantProfiles)
				.set({ telegramUserId })
				.where(eq(tenantProfiles.id, profile.id));
		}
	}

	let idempotent = false;

	if (managedTenant.claimedByUserId === null) {
		const claimed = await tx
			.update(managedTenants)
			.set({
				claimedByUserId: actorUserId,
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
			if (current[0]?.claimedByUserId === actorUserId) {
				idempotent = true;
			} else {
				throw inviteError('MANAGED_TENANT_ALREADY_CLAIMED');
			}
		}
	} else if (managedTenant.claimedByUserId === actorUserId) {
		idempotent = true;
	} else {
		throw inviteError('MANAGED_TENANT_ALREADY_CLAIMED');
	}

	const inviteStillPending = invite.status === 'PENDING' && !invite.usedAt;
	if (!idempotent || inviteStillPending) {
		await markInviteAccepted(tx, invite, actorUserId, now);

		if (!idempotent) {
			await appendAudit(
				tx,
				auditActorFromUserActor(
					{
						kind: 'USER',
						userId: actorUserId,
						role: 'TENANT',
						tenantProfileId: actorTenantProfileId
					},
					invite.landlordId
				),
				{
					action: 'TENANCY.INVITE_ACCEPTED',
					resourceType: 'ManagedTenant',
					resourceId: invite.managedTenantId!,
					landlordId: invite.landlordId,
					requestId,
					scope: 'LANDLORD',
					metadata: {
						tenancyId: invite.tenancyId!,
						inviteId: invite.id
					}
				}
			);
		}
	}

	return idempotent;
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
	const actorUserId = input.actorUserId.trim();
	const actorTenantProfileId = input.actorTenantProfileId.trim();

	return conn.transaction(async (tx) => {
		const invite = await lockInviteByTokenHash(tx, tokenHash);

		const replay = await tryIdempotentAcceptReplay(
			tx,
			invite,
			actorUserId,
			actorTenantProfileId,
			now
		);
		if (replay) return replay;

		assertInviteAcceptable(invite, now);

		const managedTenantRows = await tx
			.select({
				id: managedTenants.id,
				landlordId: managedTenants.landlordId,
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
				landlordId: tenancies.landlordId,
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
		assertAcceptLandlordBinding(invite, managedTenant, tenancy);

		await assertActiveTenantActor(tx, actorUserId, actorTenantProfileId);

		const tenancyBefore = await countTenanciesContractsInvoices(tx, invite.tenancyId!);

		const idempotent = await performManagedTenantClaim(tx, {
			managedTenant,
			invite,
			actorUserId,
			actorTenantProfileId,
			telegramUserId: input.telegramUserId,
			now,
			requestId: options.requestId ?? null
		});

		const tenancyAfter = await countTenanciesContractsInvoices(tx, invite.tenancyId!);
		if (
			tenancyBefore.tenancies !== tenancyAfter.tenancies ||
			tenancyBefore.contracts !== tenancyAfter.contracts ||
			tenancyBefore.invoices !== tenancyAfter.invoices
		) {
			throw new Error('acceptTenantInvite mutated tenancy/contract/invoice counts');
		}

		return {
			managedTenantId: invite.managedTenantId!,
			tenancyId: invite.tenancyId!,
			claimedByUserId: actorUserId,
			idempotent
		};
	});
}

/**
 * Telegram Mini App claim: validate invite first, then create/link identity and consume
 * inside the same transaction so invalid tokens never leave an active User behind.
 */
export async function claimTenantInviteViaTelegram(
	conn: TenantInviteDb,
	input: ClaimTenantInviteViaTelegramInput,
	options: TenantInviteServiceOptions = {}
): Promise<ClaimTenantInviteViaTelegramResult> {
	if (!input.token?.trim() || !input.telegramUserId?.trim()) {
		throw inviteError('IDENTITY_REQUIRED');
	}

	const now = options.now ?? new Date();
	const tokenHash = hashInviteToken(input.token.trim());
	const telegramUserId = input.telegramUserId.trim();

	return conn.transaction(async (tx) => {
		const invite = await lockInviteByTokenHash(tx, tokenHash);

		const linked = await tx
			.select({
				profileId: tenantProfiles.id,
				userId: tenantProfiles.userId,
				isActive: users.isActive,
				role: users.role
			})
			.from(tenantProfiles)
			.innerJoin(users, eq(tenantProfiles.userId, users.id))
			.where(eq(tenantProfiles.telegramUserId, telegramUserId))
			.limit(1);

		if (linked[0]) {
			if (!linked[0].isActive || linked[0].role !== 'TENANT') {
				throw inviteError('IDENTITY_REQUIRED');
			}
			const replay = await tryIdempotentAcceptReplay(
				tx,
				invite,
				linked[0].userId,
				linked[0].profileId,
				now
			);
			if (replay) {
				return {
					...replay,
					userId: linked[0].userId,
					tenantProfileId: linked[0].profileId
				};
			}
		}

		assertInviteAcceptable(invite, now);

		const managedTenantRows = await tx
			.select({
				id: managedTenants.id,
				landlordId: managedTenants.landlordId,
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
				landlordId: tenancies.landlordId,
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
		assertAcceptLandlordBinding(invite, managedTenant, tenancy);

		const tenancyBefore = await countTenanciesContractsInvoices(tx, invite.tenancyId!);

		const identity = await ensureTelegramIdentityInTx(tx, telegramUserId, input.displayName);

		const idempotent = await performManagedTenantClaim(tx, {
			managedTenant,
			invite,
			actorUserId: identity.userId,
			actorTenantProfileId: identity.tenantProfileId,
			telegramUserId,
			now,
			requestId: options.requestId ?? null
		});

		const tenancyAfter = await countTenanciesContractsInvoices(tx, invite.tenancyId!);
		if (
			tenancyBefore.tenancies !== tenancyAfter.tenancies ||
			tenancyBefore.contracts !== tenancyAfter.contracts ||
			tenancyBefore.invoices !== tenancyAfter.invoices
		) {
			throw new Error('claimTenantInviteViaTelegram mutated tenancy/contract/invoice counts');
		}

		return {
			managedTenantId: invite.managedTenantId!,
			tenancyId: invite.tenancyId!,
			claimedByUserId: identity.userId,
			idempotent,
			userId: identity.userId,
			tenantProfileId: identity.tenantProfileId
		};
	});
}
