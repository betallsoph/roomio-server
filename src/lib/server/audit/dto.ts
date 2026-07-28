import { isAuditAction, type AuditAction } from './actions.js';

/** Public audit event shape — allowlisted fields only (no createdAt or DB internals). */
export type AuditEventDto = {
	id: string;
	landlordId: string | null;
	action: AuditAction;
	actorType: 'USER' | 'MACHINE' | 'SYSTEM';
	actorUserId: string | null;
	actorRole: string | null;
	resourceType: string;
	resourceId: string;
	requestId: string | null;
	jobId: string | null;
	metadata: Record<string, unknown>;
	occurredAt: string;
};

export type AuditEventRow = {
	id: string;
	landlordId: string | null;
	actorType: string;
	actorUserId: string | null;
	actorRole: string | null;
	action: string;
	resourceType: string;
	resourceId: string;
	requestId: string | null;
	jobId: string | null;
	metadata: unknown;
	metadataVersion: number;
	occurredAt: Date;
	createdAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function normalizeActorType(value: string): AuditEventDto['actorType'] {
	if (value === 'USER' || value === 'MACHINE' || value === 'SYSTEM') return value;
	throw new Error(`Invalid audit actorType in storage: ${value}`);
}

export function toAuditEventDto(row: AuditEventRow): AuditEventDto {
	if (!isAuditAction(row.action)) {
		throw new Error(`Invalid audit action in storage: ${row.action}`);
	}

	return {
		id: row.id,
		landlordId: row.landlordId,
		action: row.action,
		actorType: normalizeActorType(row.actorType),
		actorUserId: row.actorUserId,
		actorRole: row.actorRole,
		resourceType: row.resourceType,
		resourceId: row.resourceId,
		requestId: row.requestId,
		jobId: row.jobId,
		metadata: normalizeMetadata(row.metadata),
		occurredAt: row.occurredAt.toISOString()
	};
}
