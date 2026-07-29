/**
 * AUTH-009 — landlord-scoped ManagedTenant lifecycle.
 * Creating a managed tenant never finds, creates, or links a User from contact snapshots.
 */

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '$lib/server/db/schema';
import { managedTenants } from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import { appendAudit, auditActorFromUserActor, type AuditTx } from '$lib/server/audit';
import {
	managedTenantError,
	normalizeCreateManagedTenantInput,
	toManagedTenantSummaryDto,
	type CreateManagedTenantInput,
	type ManagedTenantSummaryDto
} from './state.js';

export type ManagedTenantDb = NodePgDatabase<typeof schema>;
export type ManagedTenantTx = AuditTx;

export type ManagedTenantServiceOptions = {
	requestId?: string | null;
};

export async function createManagedTenant(
	conn: ManagedTenantDb,
	actor: LandlordActor,
	rawInput: unknown,
	options: ManagedTenantServiceOptions = {}
): Promise<ManagedTenantSummaryDto> {
	const input: CreateManagedTenantInput = normalizeCreateManagedTenantInput(rawInput);

	return conn.transaction(async (tx) => {
		const inserted = await tx
			.insert(managedTenants)
			.values({
				landlordId: actor.landlordId,
				displayName: input.displayName,
				emailSnapshot: input.email,
				phoneSnapshot: input.phone,
				createdByActorType: 'USER',
				createdByUserId: actor.userId,
				status: 'ACTIVE'
			})
			.returning({
				id: managedTenants.id,
				landlordId: managedTenants.landlordId,
				displayName: managedTenants.displayName,
				emailSnapshot: managedTenants.emailSnapshot,
				phoneSnapshot: managedTenants.phoneSnapshot,
				claimedByUserId: managedTenants.claimedByUserId,
				claimVersion: managedTenants.claimVersion,
				status: managedTenants.status,
				createdAt: managedTenants.createdAt
			});

		const row = inserted[0];
		if (!row) throw new Error('createManagedTenant insert did not return a row');

		await appendAudit(tx, auditActorFromUserActor(actor), {
			action: 'TENANCY.CREATED',
			resourceType: 'ManagedTenant',
			resourceId: row.id,
			landlordId: actor.landlordId,
			requestId: options.requestId ?? null,
			scope: 'LANDLORD',
			metadata: { status: row.status }
		});

		return toManagedTenantSummaryDto(row);
	});
}

export async function loadManagedTenantInScope(
	tx: ManagedTenantTx,
	actor: LandlordActor,
	managedTenantId: string
) {
	const rows = await tx
		.select({
			id: managedTenants.id,
			landlordId: managedTenants.landlordId,
			displayName: managedTenants.displayName,
			emailSnapshot: managedTenants.emailSnapshot,
			phoneSnapshot: managedTenants.phoneSnapshot,
			claimedByUserId: managedTenants.claimedByUserId,
			claimVersion: managedTenants.claimVersion,
			legacyTenantProfileId: managedTenants.legacyTenantProfileId,
			status: managedTenants.status,
			createdAt: managedTenants.createdAt
		})
		.from(managedTenants)
		.where(
			and(eq(managedTenants.id, managedTenantId), eq(managedTenants.landlordId, actor.landlordId))
		)
		.for('update')
		.limit(1);

	const row = rows[0];
	if (!row) throw managedTenantError('MANAGED_TENANT_NOT_FOUND', 'Không tìm thấy hồ sơ người thuê');
	if (row.status === 'ARCHIVED') {
		throw managedTenantError('MANAGED_TENANT_ARCHIVED', 'Hồ sơ người thuê đã lưu trữ');
	}
	return row;
}
