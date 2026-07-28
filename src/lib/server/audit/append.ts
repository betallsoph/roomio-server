import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditEvents } from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { AUDIT_ACTION_VERSION, type AuditAction, isAuditAction } from './actions.js';
import type { AuditActorRef } from './actors.js';
import { AuditValidationError, validateAuditMetadata } from './metadata.js';

export type AuditTx = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];

export type AppendAuditScope = 'LANDLORD' | 'PLATFORM';

export type AppendAuditInput = {
	action: AuditAction;
	resourceType: string;
	resourceId: string;
	landlordId?: string | null;
	requestId?: string | null;
	jobId?: string | null;
	metadata?: Record<string, unknown>;
	occurredAt?: Date;
	scope: AppendAuditScope;
};

function requireNonEmptyId(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new AuditValidationError('INVALID_RESOURCE', `${field} must be a non-empty string`);
	}
	return trimmed;
}

function resolveLandlordId(
	scope: AppendAuditScope,
	eventLandlordId: string | null | undefined,
	actor: AuditActorRef
): string | null {
	if (scope === 'PLATFORM') {
		if (eventLandlordId != null) {
			throw new AuditValidationError(
				'INVALID_SCOPE',
				'Platform audit events must not include landlordId'
			);
		}
		return null;
	}

	const landlordId = eventLandlordId ?? actor.landlordIdHint;
	if (typeof landlordId !== 'string' || landlordId.trim() === '') {
		throw new AuditValidationError(
			'MISSING_LANDLORD_ID',
			'Landlord-scoped audit events require a non-empty landlordId'
		);
	}
	return landlordId.trim();
}

export async function appendAudit(
	tx: AuditTx,
	actor: AuditActorRef,
	event: AppendAuditInput
): Promise<{ id: string }> {
	if (!isAuditAction(event.action)) {
		throw new AuditValidationError('INVALID_ACTION', `Unsupported audit action: ${event.action}`);
	}

	if (actor.actorType === 'USER' && !actor.actorUserId) {
		throw new AuditValidationError(
			'MISSING_ACTOR_USER_ID',
			'USER audit events require actorUserId'
		);
	}

	const landlordId = resolveLandlordId(event.scope, event.landlordId, actor);
	const metadata = validateAuditMetadata(event.metadata ?? {}, AUDIT_ACTION_VERSION);

	const rows = await tx
		.insert(auditEvents)
		.values({
			landlordId,
			actorType: actor.actorType,
			actorUserId: actor.actorUserId,
			actorRole: actor.actorRole,
			action: event.action,
			resourceType: requireNonEmptyId(event.resourceType, 'resourceType'),
			resourceId: requireNonEmptyId(event.resourceId, 'resourceId'),
			requestId: event.requestId ?? null,
			jobId: event.jobId ?? null,
			metadata,
			metadataVersion: AUDIT_ACTION_VERSION,
			occurredAt: event.occurredAt ?? new Date()
		})
		.returning({ id: auditEvents.id });

	const id = rows[0]?.id;
	if (!id) {
		throw new Error('appendAudit insert did not return id');
	}

	return { id };
}
