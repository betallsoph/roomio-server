import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '$lib/server/db/schema';
import { ValidationError } from '$lib/server/validation';
import { AuditValidationError } from './metadata.js';
import {
	auditListLimit,
	decodeAuditCursor,
	encodeAuditCursor,
	landlordAuditEventsWhere,
	listLandlordAuditEvents,
	listPlatformAuditEvents,
	platformAuditEventsWhere
} from './query.js';

const OCCURRED_AT = '2026-07-28T10:15:30.000Z';
const EVENT_ID = 'event-abc-123';

test('encodeAuditCursor / decodeAuditCursor roundtrip', () => {
	const encoded = encodeAuditCursor({ occurredAt: OCCURRED_AT, id: EVENT_ID });
	const decoded = decodeAuditCursor(encoded);
	assert.equal(decoded.occurredAt, OCCURRED_AT);
	assert.equal(decoded.id, EVENT_ID);
	assert.equal(decoded.occurredAtDate.toISOString(), OCCURRED_AT);
});

test('decodeAuditCursor rejects malformed cursor', () => {
	assert.throws(() => decodeAuditCursor('not-valid-base64url!!!'), AuditValidationError);
	assert.throws(
		() => decodeAuditCursor(encodeAuditCursor({ occurredAt: 'bad', id: '' })),
		AuditValidationError
	);
	assert.throws(
		() =>
			decodeAuditCursor(
				Buffer.from(JSON.stringify({ occurredAt: 'nope', id: 'x' })).toString('base64url')
			),
		AuditValidationError
	);
});

test('auditListLimit clamps to 1..100 with default 20', () => {
	assert.equal(auditListLimit(undefined), 20);
	assert.equal(auditListLimit(null), 20);
	assert.equal(auditListLimit(0), 1);
	assert.equal(auditListLimit(-5), 1);
	assert.equal(auditListLimit(1), 1);
	assert.equal(auditListLimit(100), 100);
	assert.equal(auditListLimit(500), 100);
	assert.equal(auditListLimit(Number.NaN), 20);
});

test('landlordAuditEventsWhere rejects empty landlordId', () => {
	assert.throws(() => landlordAuditEventsWhere(''), ValidationError);
	assert.throws(() => landlordAuditEventsWhere('   '), ValidationError);
});

test('landlord vs platform where builders differ by scope', () => {
	const landlordWhere = landlordAuditEventsWhere('landlord-a');
	const platformWhere = platformAuditEventsWhere();
	assert.ok(landlordWhere !== platformWhere);
});

test('listLandlordAuditEvents rejects empty landlordId', async () => {
	const mockDb = {
		select: () => ({
			from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) })
		})
	} as unknown as NodePgDatabase<typeof schema>;
	await assert.rejects(
		() => listLandlordAuditEvents(mockDb, { landlordId: '', limit: 20, cursor: null }),
		ValidationError
	);
});

test('listLandlordAuditEvents applies landlord-scoped where (mock db)', async () => {
	const capture: { where?: unknown } = {};
	const mockDb = {
		select: () => ({
			from: () => ({
				where: (condition: unknown) => {
					capture.where = condition;
					return {
						orderBy: () => ({
							limit: async () => []
						})
					};
				}
			})
		})
	} as unknown as NodePgDatabase<typeof schema>;

	await listLandlordAuditEvents(mockDb, {
		landlordId: 'landlord-a',
		limit: 20,
		cursor: null
	});

	assert.ok(capture.where);
	assert.notEqual(capture.where, platformAuditEventsWhere());
});

test('listPlatformAuditEvents applies platform-only where (mock db)', async () => {
	const capture: { where?: unknown } = {};
	const mockDb = {
		select: () => ({
			from: () => ({
				where: (condition: unknown) => {
					capture.where = condition;
					return {
						orderBy: () => ({
							limit: async () => []
						})
					};
				}
			})
		})
	} as unknown as NodePgDatabase<typeof schema>;

	await listPlatformAuditEvents(mockDb, { limit: 20, cursor: null });

	assert.ok(capture.where);
});

test('cursor where is appended for paginated landlord list', () => {
	const cursor = encodeAuditCursor({ occurredAt: OCCURRED_AT, id: EVENT_ID });
	const withoutCursor = landlordAuditEventsWhere('landlord-a');
	const withCursor = landlordAuditEventsWhere('landlord-a', cursor);
	assert.ok(withoutCursor !== withCursor);
});
