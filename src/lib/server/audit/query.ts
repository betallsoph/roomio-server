import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { Db } from '$lib/server/db';
import { auditEvents } from '$lib/server/db/schema';
import { ValidationError } from '$lib/server/validation';
import { AuditValidationError } from './metadata.js';
import { toAuditEventDto, type AuditEventDto } from './dto.js';

export type AuditListResult = {
	items: AuditEventDto[];
	nextCursor: string | null;
};

export type AuditListOptions = {
	limit?: number | null;
	cursor?: string | null;
};

export type LandlordAuditListOptions = AuditListOptions & {
	landlordId: string;
};

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

type AuditCursorPayload = {
	occurredAt: string;
	id: string;
};

type DecodedAuditCursor = AuditCursorPayload & {
	occurredAtDate: Date;
};

export function auditListLimit(limit?: number | null): number {
	if (limit === undefined || limit === null) return DEFAULT_LIMIT;
	const parsed = Math.floor(Number(limit));
	if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
	return Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
}

export function encodeAuditCursor(payload: AuditCursorPayload): string {
	return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeAuditCursor(cursor: string): DecodedAuditCursor {
	try {
		const raw = Buffer.from(cursor, 'base64url').toString('utf8');
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new AuditValidationError('INVALID_CURSOR', 'Cursor không hợp lệ');
		}
		const record = parsed as Record<string, unknown>;
		const occurredAt = typeof record.occurredAt === 'string' ? record.occurredAt : null;
		const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null;
		if (!occurredAt || !id) {
			throw new AuditValidationError('INVALID_CURSOR', 'Cursor không hợp lệ');
		}
		const occurredAtDate = new Date(occurredAt);
		if (Number.isNaN(occurredAtDate.getTime())) {
			throw new AuditValidationError('INVALID_CURSOR', 'Cursor không hợp lệ');
		}
		return { occurredAt, id, occurredAtDate };
	} catch (error) {
		if (error instanceof AuditValidationError) throw error;
		throw new AuditValidationError('INVALID_CURSOR', 'Cursor không hợp lệ');
	}
}

function assertLandlordId(landlordId: string): void {
	if (typeof landlordId !== 'string' || !landlordId.trim()) {
		throw new ValidationError('landlordId không hợp lệ');
	}
}

export function auditEventsBeforeCursor(cursor: string): SQL {
	const { occurredAtDate, id } = decodeAuditCursor(cursor);
	return or(
		lt(auditEvents.occurredAt, occurredAtDate),
		and(eq(auditEvents.occurredAt, occurredAtDate), lt(auditEvents.id, id))
	)!;
}

export function landlordAuditEventsWhere(
	landlordId: string,
	cursor?: string | null
): SQL | undefined {
	assertLandlordId(landlordId);
	const conditions: SQL[] = [eq(auditEvents.landlordId, landlordId.trim())];
	if (cursor) {
		conditions.push(auditEventsBeforeCursor(cursor));
	}
	return and(...conditions);
}

export function platformAuditEventsWhere(cursor?: string | null): SQL | undefined {
	const conditions: SQL[] = [isNull(auditEvents.landlordId)];
	if (cursor) {
		conditions.push(auditEventsBeforeCursor(cursor));
	}
	return and(...conditions);
}

export async function listLandlordAuditEvents(
	db: Db,
	options: LandlordAuditListOptions
): Promise<AuditListResult> {
	const limit = auditListLimit(options.limit);
	const rows = await db
		.select()
		.from(auditEvents)
		.where(landlordAuditEventsWhere(options.landlordId, options.cursor))
		.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
		.limit(limit + 1);

	return toAuditListResult(rows, limit);
}

export async function listPlatformAuditEvents(
	db: Db,
	options: AuditListOptions
): Promise<AuditListResult> {
	const limit = auditListLimit(options.limit);
	const rows = await db
		.select()
		.from(auditEvents)
		.where(platformAuditEventsWhere(options.cursor))
		.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
		.limit(limit + 1);

	return toAuditListResult(rows, limit);
}

function toAuditListResult(
	rows: (typeof auditEvents.$inferSelect)[],
	limit: number
): AuditListResult {
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const items = page.map(toAuditEventDto);
	const last = page.at(-1);
	const nextCursor =
		hasMore && last
			? encodeAuditCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id })
			: null;
	return { items, nextCursor };
}
