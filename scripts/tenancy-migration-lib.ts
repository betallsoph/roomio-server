/**
 * AUTH-007 — shared logic for profiler, backfill, and reconciliation scripts.
 * Read-only profiler paths never mutate. Backfill defaults to dry-run; commit requires
 * explicit flag plus BACKFILL_TENANCY_ENV_ALLOWLIST (never production).
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/lib/server/db/schema.js';
import {
	contracts,
	invoices,
	managedTenants,
	maintenanceRequests,
	meterReadings,
	properties,
	rooms,
	tenantProfiles,
	tenancies,
	users
} from '../src/lib/server/db/schema.js';

export type TenancyMigrationDb = NodePgDatabase<typeof schema>;

export type BackfillReport = {
	scanned: number;
	managedTenantsCreated: number;
	claimed: number;
	tenanciesMapped: number;
	unresolved: number;
	skipped: number;
	errors: number;
};

export const EMPTY_REPORT: BackfillReport = {
	scanned: 0,
	managedTenantsCreated: 0,
	claimed: 0,
	tenanciesMapped: 0,
	unresolved: 0,
	skipped: 0,
	errors: 0
};

export type BackfillPhase =
	| 'managed_tenants'
	| 'tenancies_contract'
	| 'tenancies_current_room'
	| 'map_resources';

export type ResourceMappingRecord = {
	table: 'Invoice' | 'Contract' | 'MeterReading' | 'MaintenanceRequest';
	id: string;
	managedTenantId: string | null;
	tenancyId: string | null;
};

export type BackfillCheckpoint = {
	runId: string;
	startedAt: string;
	landlordId: string | null;
	dryRun: boolean;
	cursor: { phase: BackfillPhase; lastId: string | null };
	stats: BackfillReport;
	created: {
		managedTenantIds: string[];
		tenancyIds: string[];
		resourceMappings: ResourceMappingRecord[];
	};
};

export type BackfillCliOptions = {
	commit: boolean;
	landlordId?: string;
	limit: number;
	batchSize: number;
	checkpointDir: string;
	resumeRunId?: string;
	rollbackRunId?: string;
};

export type ProfilerAggregate = {
	roomsWithCurrentTenant: number;
	roomsWithoutCurrentTenant: number;
	roomsWithOverlappingContracts: number;
	legacyProfilesInMultipleLandlords: number;
	resourcesMissingScope: {
		invoices: number;
		contracts: number;
		meterReadings: number;
		maintenanceRequests: number;
	};
	duplicateContactSnapshotGroups: number;
	mismatchedSnapshotRows: number;
	sampleTechnicalIds: {
		overlappingContractRooms: string[];
		multiLandlordProfiles: string[];
		unscopedInvoiceIds: string[];
	};
};

export const BACKFILL_SOURCE_PREFIX = 'AUTH007';
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_CHECKPOINT_DIR = '.checkpoints/tenancy-backfill';

export function mergeReport(base: BackfillReport, delta: Partial<BackfillReport>): BackfillReport {
	return {
		scanned: base.scanned + (delta.scanned ?? 0),
		managedTenantsCreated: base.managedTenantsCreated + (delta.managedTenantsCreated ?? 0),
		claimed: base.claimed + (delta.claimed ?? 0),
		tenanciesMapped: base.tenanciesMapped + (delta.tenanciesMapped ?? 0),
		unresolved: base.unresolved + (delta.unresolved ?? 0),
		skipped: base.skipped + (delta.skipped ?? 0),
		errors: base.errors + (delta.errors ?? 0)
	};
}

export function buildBackfillSource(runId: string, source: string): string {
	return `${BACKFILL_SOURCE_PREFIX}:${runId}:${source}`;
}

export function parseBackfillSource(
	value: string | null | undefined
): { runId: string; source: string } | null {
	if (!value?.startsWith(`${BACKFILL_SOURCE_PREFIX}:`)) return null;
	const parts = value.split(':');
	if (parts.length < 3) return null;
	return { runId: parts[1]!, source: parts.slice(2).join(':') };
}

export function belongsToBackfillRun(
	backfillSource: string | null | undefined,
	runId: string
): boolean {
	return parseBackfillSource(backfillSource)?.runId === runId;
}

/** Hash contact for duplicate counting — never log/store raw values in reports. */
export function contactFingerprint(email: string | null, phone: string | null): string | null {
	const normalizedEmail = email?.trim().toLowerCase() ?? '';
	const normalizedPhone = phone?.replace(/\D/g, '') ?? '';
	if (!normalizedEmail && !normalizedPhone) return null;
	return crypto.createHash('sha256').update(`${normalizedEmail}|${normalizedPhone}`).digest('hex');
}

export function datesOverlap(
	aStart: string,
	aEnd: string | null,
	bStart: string,
	bEnd: string | null
): boolean {
	const aEndEff = aEnd ?? '9999-12-31';
	const bEndEff = bEnd ?? '9999-12-31';
	return aStart <= bEndEff && bStart <= aEndEff;
}

export type TenancyCandidate = {
	id: string;
	managedTenantId: string | null;
	roomId: string;
	startDate: string;
	endDate: string | null;
	status: string;
	backfillSource: string | null;
};

/** Pick exactly one tenancy covering a calendar date, or null if ambiguous/missing. */
export function findTenancyForDate(
	candidates: TenancyCandidate[],
	roomId: string,
	onDate: string
): TenancyCandidate | 'ambiguous' | null {
	const covering = candidates.filter(
		(t) =>
			t.roomId === roomId && t.startDate <= onDate && (t.endDate === null || t.endDate >= onDate)
	);
	if (covering.length === 1) return covering[0]!;
	if (covering.length === 0) return null;
	return 'ambiguous';
}

export type ContractWindow = {
	id: string;
	roomId: string;
	tenantId: string;
	startDate: string;
	endDate: string;
	status: string;
};

export function detectOverlappingContracts(rows: ContractWindow[]): Set<string> {
	const byRoom = new Map<string, ContractWindow[]>();
	for (const row of rows) {
		const list = byRoom.get(row.roomId) ?? [];
		list.push(row);
		byRoom.set(row.roomId, list);
	}
	const overlappingRooms = new Set<string>();
	for (const [roomId, roomContracts] of byRoom) {
		const sorted = [...roomContracts].sort((a, b) => a.startDate.localeCompare(b.startDate));
		for (let i = 0; i < sorted.length; i++) {
			for (let j = i + 1; j < sorted.length; j++) {
				if (
					datesOverlap(
						sorted[i]!.startDate,
						sorted[i]!.endDate,
						sorted[j]!.startDate,
						sorted[j]!.endDate
					)
				) {
					overlappingRooms.add(roomId);
				}
			}
		}
	}
	return overlappingRooms;
}

export type ResourceMappingInput = {
	roomId: string;
	eventDate: string;
	resourceKind: 'invoice' | 'meter' | 'maintenance';
	tenancyCandidates: TenancyCandidate[];
};

export type ResourceMappingDecision =
	| { action: 'map'; tenancyId: string; managedTenantId: string }
	| { action: 'unresolved'; reason: string }
	| { action: 'skip'; reason: string };

/**
 * Invoice/contract/meter mapping policy:
 * - already-reviewed rows are skipped by caller
 * - room+occupant only without contract evidence → unresolved (no auto-map)
 * - exactly one tenancy covering date → map
 */
function tenancyFromContract(source: string | null): boolean {
	return source?.includes(':CONTRACT') ?? false;
}

export function decideResourceMapping(input: ResourceMappingInput): ResourceMappingDecision {
	const match = findTenancyForDate(input.tenancyCandidates, input.roomId, input.eventDate);
	if (match === 'ambiguous') {
		return { action: 'unresolved', reason: 'AMBIGUOUS_TENANCY' };
	}
	if (!match || !match.managedTenantId) {
		return { action: 'unresolved', reason: 'NO_TENANCY_COVERAGE' };
	}
	if (input.resourceKind === 'invoice' && !tenancyFromContract(match.backfillSource)) {
		return { action: 'unresolved', reason: 'ROOM_OCCUPANT_WITHOUT_CONTRACT' };
	}
	return {
		action: 'map',
		tenancyId: match.id,
		managedTenantId: match.managedTenantId
	};
}

export function parseBackfillCliArgs(argv: string[]): BackfillCliOptions {
	const opts: BackfillCliOptions = {
		commit: false,
		limit: Number.POSITIVE_INFINITY,
		batchSize: DEFAULT_BATCH_SIZE,
		checkpointDir: DEFAULT_CHECKPOINT_DIR
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		switch (arg) {
			case '--commit':
				opts.commit = true;
				break;
			case '--dry-run':
				opts.commit = false;
				break;
			case '--landlord-id':
				opts.landlordId = argv[++i];
				break;
			case '--limit':
				opts.limit = Number(argv[++i]);
				break;
			case '--batch-size':
				opts.batchSize = Number(argv[++i]);
				break;
			case '--checkpoint-dir':
				opts.checkpointDir = argv[++i]!;
				break;
			case '--resume':
				opts.resumeRunId = argv[++i];
				break;
			case '--rollback':
				opts.rollbackRunId = argv[++i];
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
		throw new Error('--limit must be a positive number');
	}
	if (!Number.isFinite(opts.batchSize) || opts.batchSize <= 0 || opts.batchSize > 500) {
		throw new Error('--batch-size must be between 1 and 500');
	}
	return opts;
}

export function assertBackfillEnvironmentAllowed(commit: boolean): void {
	const nodeEnv = (process.env.NODE_ENV ?? 'development').trim().toLowerCase();
	if (nodeEnv === 'production') {
		throw new Error('AUTH-007 scripts are forbidden in production');
	}
	if (!commit) return;
	const allowlist = (process.env.BACKFILL_TENANCY_ENV_ALLOWLIST ?? '')
		.split(',')
		.map((v) => v.trim().toLowerCase())
		.filter(Boolean);
	if (allowlist.length === 0) {
		throw new Error(
			'Commit mode requires BACKFILL_TENANCY_ENV_ALLOWLIST (e.g. development,staging,test)'
		);
	}
	if (!allowlist.includes(nodeEnv)) {
		throw new Error(`NODE_ENV=${nodeEnv} is not in BACKFILL_TENANCY_ENV_ALLOWLIST`);
	}
}

export function createScriptDb(): {
	db: TenancyMigrationDb;
	pool: Pool;
	close: () => Promise<void>;
} {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl?.startsWith('postgres')) {
		throw new Error('DATABASE_URL must be a postgres connection string');
	}
	const pool = new Pool({ connectionString: databaseUrl, max: 2 });
	const db = drizzle(pool, { schema });
	return {
		db,
		pool,
		close: async () => {
			await pool.end();
		}
	};
}

export function checkpointPath(checkpointDir: string, runId: string): string {
	return path.join(checkpointDir, `tenancy-backfill-${runId}.json`);
}

export async function loadCheckpoint(
	checkpointDir: string,
	runId: string
): Promise<BackfillCheckpoint | null> {
	try {
		const raw = await fs.readFile(checkpointPath(checkpointDir, runId), 'utf8');
		return JSON.parse(raw) as BackfillCheckpoint;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
}

export async function saveCheckpoint(
	checkpointDir: string,
	checkpoint: BackfillCheckpoint
): Promise<void> {
	await fs.mkdir(checkpointDir, { recursive: true });
	await fs.writeFile(
		checkpointPath(checkpointDir, checkpoint.runId),
		JSON.stringify(checkpoint, null, 2),
		'utf8'
	);
}

export function newCheckpoint(opts: BackfillCliOptions, runId: string): BackfillCheckpoint {
	return {
		runId,
		startedAt: new Date().toISOString(),
		landlordId: opts.landlordId ?? null,
		dryRun: !opts.commit,
		cursor: { phase: 'managed_tenants', lastId: null },
		stats: { ...EMPTY_REPORT },
		created: { managedTenantIds: [], tenancyIds: [], resourceMappings: [] }
	};
}

export async function validateLandlordId(
	db: TenancyMigrationDb,
	landlordId: string
): Promise<void> {
	const rows = await db
		.select({ id: schema.landlordProfiles.id })
		.from(schema.landlordProfiles)
		.where(eq(schema.landlordProfiles.id, landlordId))
		.limit(1);
	if (rows.length === 0) {
		throw new Error(`Unknown landlord id: ${landlordId}`);
	}
}

type LegacyPairRow = {
	landlordId: string;
	legacyTenantProfileId: string;
	userId: string;
	displayName: string;
	email: string;
	phone: string;
	moveInDate: string | null;
};

async function loadLegacyPairs(
	db: TenancyMigrationDb,
	landlordId: string | undefined,
	afterId: string | null,
	limit: number
): Promise<LegacyPairRow[]> {
	const whereClause = landlordId
		? and(isNotNull(rooms.tenantId), eq(properties.landlordId, landlordId))
		: isNotNull(rooms.tenantId);

	const rows = await db
		.select({
			landlordId: properties.landlordId,
			legacyTenantProfileId: rooms.tenantId,
			userId: tenantProfiles.userId,
			displayName: users.name,
			email: users.email,
			phone: users.phone,
			moveInDate: tenantProfiles.moveInDate
		})
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.innerJoin(tenantProfiles, eq(rooms.tenantId, tenantProfiles.id))
		.innerJoin(users, eq(tenantProfiles.userId, users.id))
		.where(whereClause)
		.orderBy(asc(properties.landlordId), asc(rooms.tenantId));

	const deduped = new Map<string, LegacyPairRow>();
	for (const row of rows) {
		if (!row.legacyTenantProfileId) continue;
		const key = `${row.landlordId}:${row.legacyTenantProfileId}`;
		if (!deduped.has(key)) deduped.set(key, row as LegacyPairRow);
	}
	const sorted = [...deduped.values()].sort((a, b) =>
		`${a.landlordId}:${a.legacyTenantProfileId}`.localeCompare(
			`${b.landlordId}:${b.legacyTenantProfileId}`
		)
	);
	if (!afterId) return sorted.slice(0, limit);
	return sorted
		.filter((r) => `${r.landlordId}:${r.legacyTenantProfileId}` > afterId)
		.slice(0, limit);
}

export async function runManagedTenantBatch(
	db: TenancyMigrationDb,
	checkpoint: BackfillCheckpoint,
	opts: BackfillCliOptions
): Promise<{ done: boolean; delta: BackfillReport }> {
	const delta: BackfillReport = { ...EMPTY_REPORT };
	const rows = await loadLegacyPairs(
		db,
		checkpoint.landlordId ?? undefined,
		checkpoint.cursor.lastId,
		opts.batchSize
	);
	if (rows.length === 0) return { done: true, delta };

	for (const row of rows) {
		delta.scanned += 1;
		const cursorKey = `${row.landlordId}:${row.legacyTenantProfileId}`;
		checkpoint.cursor.lastId = cursorKey;

		const existing = await db
			.select({ id: managedTenants.id, claimedByUserId: managedTenants.claimedByUserId })
			.from(managedTenants)
			.where(
				and(
					eq(managedTenants.landlordId, row.landlordId),
					eq(managedTenants.legacyTenantProfileId, row.legacyTenantProfileId)
				)
			)
			.limit(1);

		if (existing.length > 0) {
			delta.skipped += 1;
			continue;
		}

		const managedTenantId = crypto.randomUUID();
		const backfillSource = buildBackfillSource(checkpoint.runId, 'LEGACY_TENANT_PROFILE');
		const shouldClaim = Boolean(row.userId);

		if (!opts.commit) {
			delta.managedTenantsCreated += 1;
			if (shouldClaim) delta.claimed += 1;
			checkpoint.created.managedTenantIds.push(managedTenantId);
			continue;
		}

		try {
			await db.insert(managedTenants).values({
				id: managedTenantId,
				landlordId: row.landlordId,
				displayName: row.displayName,
				emailSnapshot: row.email,
				phoneSnapshot: row.phone,
				claimedByUserId: shouldClaim ? row.userId : null,
				claimVersion: shouldClaim ? 1 : 0,
				status: 'ACTIVE',
				legacyTenantProfileId: row.legacyTenantProfileId,
				backfillSource,
				needsReview: false,
				createdByActorType: 'SYSTEM',
				createdByUserId: null
			});
			delta.managedTenantsCreated += 1;
			if (shouldClaim) delta.claimed += 1;
			checkpoint.created.managedTenantIds.push(managedTenantId);
		} catch {
			delta.errors += 1;
		}
	}

	return { done: rows.length < opts.batchSize, delta };
}

type ContractBackfillRow = {
	contractId: string;
	roomId: string;
	propertyId: string;
	landlordId: string;
	tenantId: string;
	startDate: string;
	endDate: string;
	status: string;
	existingTenancyId: string | null;
};

async function loadContractRows(
	db: TenancyMigrationDb,
	landlordId: string | undefined,
	afterId: string | null,
	limit: number
): Promise<ContractBackfillRow[]> {
	const rows = await db
		.select({
			contractId: contracts.id,
			roomId: contracts.roomId,
			propertyId: properties.id,
			landlordId: properties.landlordId,
			tenantId: contracts.tenantId,
			startDate: contracts.startDate,
			endDate: contracts.endDate,
			status: contracts.status,
			existingTenancyId: contracts.tenancyId
		})
		.from(contracts)
		.innerJoin(rooms, eq(contracts.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(landlordId ? eq(properties.landlordId, landlordId) : undefined)
		.orderBy(asc(contracts.id));
	const filtered = afterId ? rows.filter((r) => r.contractId > afterId) : rows;
	return filtered.slice(0, limit);
}

export async function runContractTenancyBatch(
	db: TenancyMigrationDb,
	checkpoint: BackfillCheckpoint,
	opts: BackfillCliOptions,
	overlappingRooms: Set<string>
): Promise<{ done: boolean; delta: BackfillReport }> {
	const delta: BackfillReport = { ...EMPTY_REPORT };
	const rows = await loadContractRows(
		db,
		checkpoint.landlordId ?? undefined,
		checkpoint.cursor.lastId,
		opts.batchSize
	);
	if (rows.length === 0) return { done: true, delta };

	for (const row of rows) {
		delta.scanned += 1;
		checkpoint.cursor.lastId = row.contractId;
		if (row.existingTenancyId) {
			delta.skipped += 1;
			continue;
		}
		if (overlappingRooms.has(row.roomId)) {
			delta.unresolved += 1;
			continue;
		}

		const managed = await db
			.select({ id: managedTenants.id })
			.from(managedTenants)
			.where(
				and(
					eq(managedTenants.landlordId, row.landlordId),
					eq(managedTenants.legacyTenantProfileId, row.tenantId)
				)
			)
			.limit(1);
		if (managed.length === 0) {
			delta.unresolved += 1;
			continue;
		}

		const tenancyId = crypto.randomUUID();
		const isActive =
			row.status === 'active' && row.endDate >= new Date().toISOString().slice(0, 10);
		const backfillSource = buildBackfillSource(checkpoint.runId, 'CONTRACT');

		if (!opts.commit) {
			delta.tenanciesMapped += 1;
			checkpoint.created.tenancyIds.push(tenancyId);
			continue;
		}

		try {
			await db.transaction(async (tx) => {
				await tx.insert(tenancies).values({
					id: tenancyId,
					landlordId: row.landlordId,
					propertyId: row.propertyId,
					roomId: row.roomId,
					managedTenantId: managed[0]!.id,
					status: isActive ? 'ACTIVE' : 'ENDED',
					startDate: row.startDate,
					plannedEndDate: row.endDate,
					endDate: isActive ? null : row.endDate,
					depositRequired: 0,
					backfillSource,
					needsReview: false,
					createdByActorType: 'SYSTEM',
					createdByUserId: null
				});
				await tx
					.update(contracts)
					.set({
						managedTenantId: managed[0]!.id,
						tenancyId
					})
					.where(and(eq(contracts.id, row.contractId), isNull(contracts.tenancyId)));
			});
			delta.tenanciesMapped += 1;
			checkpoint.created.tenancyIds.push(tenancyId);
			checkpoint.created.resourceMappings.push({
				table: 'Contract',
				id: row.contractId,
				managedTenantId: managed[0]!.id,
				tenancyId
			});
		} catch {
			delta.errors += 1;
		}
	}

	return { done: rows.length < opts.batchSize, delta };
}

export async function loadOverlappingContractRooms(
	db: TenancyMigrationDb,
	landlordId?: string
): Promise<Set<string>> {
	const rows = await db
		.select({
			id: contracts.id,
			roomId: contracts.roomId,
			tenantId: contracts.tenantId,
			startDate: contracts.startDate,
			endDate: contracts.endDate,
			status: contracts.status
		})
		.from(contracts)
		.innerJoin(rooms, eq(contracts.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(landlordId ? eq(properties.landlordId, landlordId) : undefined);
	return detectOverlappingContracts(rows);
}

type CurrentRoomRow = {
	roomId: string;
	propertyId: string;
	landlordId: string;
	tenantId: string;
	moveInDate: string | null;
};

async function loadCurrentRoomRows(
	db: TenancyMigrationDb,
	landlordId: string | undefined,
	afterId: string | null,
	limit: number
): Promise<CurrentRoomRow[]> {
	const rows = await db
		.select({
			roomId: rooms.id,
			propertyId: properties.id,
			landlordId: properties.landlordId,
			tenantId: rooms.tenantId,
			moveInDate: tenantProfiles.moveInDate
		})
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.innerJoin(tenantProfiles, eq(rooms.tenantId, tenantProfiles.id))
		.where(
			and(isNotNull(rooms.tenantId), landlordId ? eq(properties.landlordId, landlordId) : undefined)
		)
		.orderBy(asc(rooms.id));
	const filtered = afterId ? rows.filter((r) => r.roomId > afterId) : rows;
	return filtered.slice(0, limit);
}

export async function runCurrentRoomTenancyBatch(
	db: TenancyMigrationDb,
	checkpoint: BackfillCheckpoint,
	opts: BackfillCliOptions
): Promise<{ done: boolean; delta: BackfillReport }> {
	const delta: BackfillReport = { ...EMPTY_REPORT };
	const rows = await loadCurrentRoomRows(
		db,
		checkpoint.landlordId ?? undefined,
		checkpoint.cursor.lastId,
		opts.batchSize
	);
	if (rows.length === 0) return { done: true, delta };

	for (const row of rows) {
		delta.scanned += 1;
		checkpoint.cursor.lastId = row.roomId;
		if (!row.tenantId) {
			delta.skipped += 1;
			continue;
		}

		const activeTenancy = await db
			.select({ id: tenancies.id })
			.from(tenancies)
			.where(and(eq(tenancies.roomId, row.roomId), eq(tenancies.status, 'ACTIVE')))
			.limit(1);
		if (activeTenancy.length > 0) {
			delta.skipped += 1;
			continue;
		}

		const managed = await db
			.select({ id: managedTenants.id })
			.from(managedTenants)
			.where(
				and(
					eq(managedTenants.landlordId, row.landlordId),
					eq(managedTenants.legacyTenantProfileId, row.tenantId)
				)
			)
			.limit(1);
		if (managed.length === 0) {
			delta.unresolved += 1;
			continue;
		}

		if (!row.moveInDate) {
			delta.unresolved += 1;
			continue;
		}

		const tenancyId = crypto.randomUUID();
		const backfillSource = buildBackfillSource(checkpoint.runId, 'CURRENT_ROOM');

		if (!opts.commit) {
			delta.tenanciesMapped += 1;
			checkpoint.created.tenancyIds.push(tenancyId);
			continue;
		}

		try {
			await db.transaction(async (tx) => {
				await tx.insert(tenancies).values({
					id: tenancyId,
					landlordId: row.landlordId,
					propertyId: row.propertyId,
					roomId: row.roomId,
					managedTenantId: managed[0]!.id,
					status: 'ACTIVE',
					startDate: row.moveInDate!,
					depositRequired: 0,
					backfillSource,
					needsReview: true,
					createdByActorType: 'SYSTEM',
					createdByUserId: null
				});
				await tx
					.update(rooms)
					.set({ currentManagedTenantId: managed[0]!.id })
					.where(eq(rooms.id, row.roomId));
			});
			delta.tenanciesMapped += 1;
			checkpoint.created.tenancyIds.push(tenancyId);
		} catch {
			delta.errors += 1;
		}
	}

	return { done: rows.length < opts.batchSize, delta };
}

async function loadTenancyCandidates(
	db: TenancyMigrationDb,
	landlordId: string | undefined
): Promise<TenancyCandidate[]> {
	return db
		.select({
			id: tenancies.id,
			managedTenantId: tenancies.managedTenantId,
			roomId: tenancies.roomId,
			startDate: tenancies.startDate,
			endDate: tenancies.endDate,
			status: tenancies.status,
			backfillSource: tenancies.backfillSource
		})
		.from(tenancies)
		.where(landlordId ? eq(tenancies.landlordId, landlordId) : undefined);
}

type InvoiceMapRow = {
	id: string;
	roomId: string;
	month: string;
	managedTenantId: string | null;
	tenancyId: string | null;
};

async function loadInvoiceMapRows(
	db: TenancyMigrationDb,
	landlordId: string | undefined,
	afterId: string | null,
	limit: number
): Promise<InvoiceMapRow[]> {
	const rows = await db
		.select({
			id: invoices.id,
			roomId: invoices.roomId,
			month: invoices.month,
			managedTenantId: invoices.managedTenantId,
			tenancyId: invoices.tenancyId
		})
		.from(invoices)
		.innerJoin(rooms, eq(invoices.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				isNull(invoices.tenancyId),
				landlordId ? eq(properties.landlordId, landlordId) : undefined
			)
		)
		.orderBy(asc(invoices.id));
	const filtered = afterId ? rows.filter((r) => r.id > afterId) : rows;
	return filtered.slice(0, limit);
}

export async function runResourceMappingBatch(
	db: TenancyMigrationDb,
	checkpoint: BackfillCheckpoint,
	opts: BackfillCliOptions,
	candidates: TenancyCandidate[]
): Promise<{ done: boolean; delta: BackfillReport }> {
	const delta: BackfillReport = { ...EMPTY_REPORT };
	const rows = await loadInvoiceMapRows(
		db,
		checkpoint.landlordId ?? undefined,
		checkpoint.cursor.lastId,
		opts.batchSize
	);
	if (rows.length === 0) return { done: true, delta };

	for (const row of rows) {
		delta.scanned += 1;
		checkpoint.cursor.lastId = row.id;
		if (row.tenancyId) {
			delta.skipped += 1;
			continue;
		}

		const eventDate = `${row.month}-01`;
		const decision = decideResourceMapping({
			roomId: row.roomId,
			eventDate,
			resourceKind: 'invoice',
			tenancyCandidates: candidates
		});

		if (decision.action === 'skip') {
			delta.skipped += 1;
			continue;
		}
		if (decision.action === 'unresolved') {
			delta.unresolved += 1;
			continue;
		}

		if (!opts.commit) {
			delta.tenanciesMapped += 1;
			continue;
		}

		try {
			await db
				.update(invoices)
				.set({
					managedTenantId: decision.managedTenantId,
					tenancyId: decision.tenancyId
				})
				.where(and(eq(invoices.id, row.id), isNull(invoices.tenancyId)));
			delta.tenanciesMapped += 1;
			checkpoint.created.resourceMappings.push({
				table: 'Invoice',
				id: row.id,
				managedTenantId: decision.managedTenantId,
				tenancyId: decision.tenancyId
			});
		} catch {
			delta.errors += 1;
		}
	}

	return { done: rows.length < opts.batchSize, delta };
}

export async function runProfileTenancyMigration(
	db: TenancyMigrationDb,
	landlordId?: string
): Promise<ProfilerAggregate> {
	if (landlordId) await validateLandlordId(db, landlordId);

	const roomRows = await db
		.select({
			roomId: rooms.id,
			tenantId: rooms.tenantId,
			landlordId: properties.landlordId
		})
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(landlordId ? eq(properties.landlordId, landlordId) : undefined);

	const roomsWithCurrentTenant = roomRows.filter((r) => r.tenantId).length;
	const roomsWithoutCurrentTenant = roomRows.length - roomsWithCurrentTenant;

	const contractRows = await db
		.select({
			id: contracts.id,
			roomId: contracts.roomId,
			tenantId: contracts.tenantId,
			startDate: contracts.startDate,
			endDate: contracts.endDate,
			status: contracts.status
		})
		.from(contracts)
		.innerJoin(rooms, eq(contracts.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(landlordId ? eq(properties.landlordId, landlordId) : undefined);

	const overlappingRooms = detectOverlappingContracts(contractRows);

	const legacyLandlordPairs = await db
		.select({
			landlordId: properties.landlordId,
			legacyTenantProfileId: rooms.tenantId
		})
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(isNotNull(rooms.tenantId));

	const profileLandlordCount = new Map<string, Set<string>>();
	for (const row of legacyLandlordPairs) {
		if (!row.legacyTenantProfileId) continue;
		const set = profileLandlordCount.get(row.legacyTenantProfileId) ?? new Set<string>();
		set.add(row.landlordId);
		profileLandlordCount.set(row.legacyTenantProfileId, set);
	}
	const multiLandlordProfiles = [...profileLandlordCount.entries()]
		.filter(([, landlords]) => landlords.size > 1)
		.map(([profileId]) => profileId);

	const unscopedInvoices = await db
		.select({ id: invoices.id })
		.from(invoices)
		.innerJoin(rooms, eq(invoices.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				isNull(invoices.tenancyId),
				landlordId ? eq(properties.landlordId, landlordId) : undefined
			)
		)
		.limit(50);

	const unscopedContracts = await db
		.select({ id: contracts.id })
		.from(contracts)
		.innerJoin(rooms, eq(contracts.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				isNull(contracts.tenancyId),
				landlordId ? eq(properties.landlordId, landlordId) : undefined
			)
		);

	const unscopedMeters = await db
		.select({ id: meterReadings.id })
		.from(meterReadings)
		.innerJoin(rooms, eq(meterReadings.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				isNull(meterReadings.tenancyId),
				landlordId ? eq(properties.landlordId, landlordId) : undefined
			)
		);

	const unscopedRequests = await db
		.select({ id: maintenanceRequests.id })
		.from(maintenanceRequests)
		.where(isNull(maintenanceRequests.tenancyId));

	// Contact duplicate groups within landlord scope (fingerprint only).
	const contactRows = await db
		.select({
			landlordId: properties.landlordId,
			email: users.email,
			phone: users.phone,
			legacyTenantProfileId: rooms.tenantId
		})
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.innerJoin(tenantProfiles, eq(rooms.tenantId, tenantProfiles.id))
		.innerJoin(users, eq(tenantProfiles.userId, users.id))
		.where(isNotNull(rooms.tenantId));

	const groups = new Map<string, Set<string>>();
	for (const row of contactRows) {
		const fp = contactFingerprint(row.email, row.phone);
		if (!fp || !row.legacyTenantProfileId) continue;
		const key = `${row.landlordId}:${fp}`;
		const set = groups.get(key) ?? new Set<string>();
		set.add(row.legacyTenantProfileId);
		groups.set(key, set);
	}
	const duplicateContactSnapshotGroups = [...groups.values()].filter((s) => s.size > 1).length;

	return {
		roomsWithCurrentTenant,
		roomsWithoutCurrentTenant,
		roomsWithOverlappingContracts: overlappingRooms.size,
		legacyProfilesInMultipleLandlords: multiLandlordProfiles.length,
		resourcesMissingScope: {
			invoices: unscopedInvoices.length,
			contracts: unscopedContracts.length,
			meterReadings: unscopedMeters.length,
			maintenanceRequests: unscopedRequests.length
		},
		duplicateContactSnapshotGroups,
		mismatchedSnapshotRows: 0,
		sampleTechnicalIds: {
			overlappingContractRooms: [...overlappingRooms].slice(0, 20),
			multiLandlordProfiles: multiLandlordProfiles.slice(0, 20),
			unscopedInvoiceIds: unscopedInvoices.map((r) => r.id).slice(0, 20)
		}
	};
}

export type ReconcileFinding = {
	code: string;
	count: number;
	sampleIds: string[];
};

export async function runTenancyReconciliation(
	db: TenancyMigrationDb,
	landlordId?: string
): Promise<ReconcileFinding[]> {
	if (landlordId) await validateLandlordId(db, landlordId);

	const findings: ReconcileFinding[] = [];

	const activeDuplicates = await db
		.select({ roomId: tenancies.roomId, count: sql<number>`count(*)::int` })
		.from(tenancies)
		.where(
			and(
				eq(tenancies.status, 'ACTIVE'),
				landlordId ? eq(tenancies.landlordId, landlordId) : undefined
			)
		)
		.groupBy(tenancies.roomId)
		.having(sql`count(*) > 1`);

	findings.push({
		code: 'DUPLICATE_ACTIVE_TENANCY_PER_ROOM',
		count: activeDuplicates.length,
		sampleIds: activeDuplicates.map((r) => r.roomId).slice(0, 20)
	});

	const orphanScope = await db
		.select({ id: invoices.id })
		.from(invoices)
		.where(
			and(
				or(isNotNull(invoices.managedTenantId), isNotNull(invoices.tenancyId)),
				isNull(invoices.tenancyId)
			)
		)
		.limit(50);

	findings.push({
		code: 'PARTIAL_SCOPE_SNAPSHOT',
		count: orphanScope.length,
		sampleIds: orphanScope.map((r) => r.id)
	});

	const outsideRange = await db
		.select({ invoiceId: invoices.id })
		.from(invoices)
		.innerJoin(tenancies, eq(invoices.tenancyId, tenancies.id))
		.where(
			and(
				sql`(${invoices.month} || '-01')::date < ${tenancies.startDate}
          OR (${invoices.month} || '-01')::date > COALESCE(${tenancies.endDate}, '9999-12-31'::date)`,
				landlordId ? eq(tenancies.landlordId, landlordId) : undefined
			)
		)
		.limit(50);

	findings.push({
		code: 'RESOURCE_OUTSIDE_TENANCY_RANGE',
		count: outsideRange.length,
		sampleIds: outsideRange.map((r) => r.invoiceId)
	});

	return findings;
}

export async function rollbackBackfillRun(
	db: TenancyMigrationDb,
	checkpoint: BackfillCheckpoint,
	commit: boolean
): Promise<BackfillReport> {
	const delta: BackfillReport = { ...EMPTY_REPORT };
	const runId = checkpoint.runId;

	for (const mapping of [...checkpoint.created.resourceMappings].reverse()) {
		delta.scanned += 1;
		if (!commit) {
			delta.skipped += 1;
			continue;
		}
		try {
			if (mapping.table === 'Invoice') {
				await db
					.update(invoices)
					.set({ managedTenantId: null, tenancyId: null })
					.where(eq(invoices.id, mapping.id));
			} else if (mapping.table === 'Contract') {
				await db
					.update(contracts)
					.set({ managedTenantId: null, tenancyId: null })
					.where(eq(contracts.id, mapping.id));
			} else if (mapping.table === 'MeterReading') {
				await db
					.update(meterReadings)
					.set({ managedTenantId: null, tenancyId: null })
					.where(eq(meterReadings.id, mapping.id));
			} else {
				await db
					.update(maintenanceRequests)
					.set({ managedTenantId: null, tenancyId: null })
					.where(eq(maintenanceRequests.id, mapping.id));
			}
			delta.tenanciesMapped += 1;
		} catch {
			delta.errors += 1;
		}
	}

	for (const tenancyId of [...checkpoint.created.tenancyIds].reverse()) {
		delta.scanned += 1;
		if (!commit) {
			delta.skipped += 1;
			continue;
		}
		const row = await db
			.select({ backfillSource: tenancies.backfillSource })
			.from(tenancies)
			.where(eq(tenancies.id, tenancyId))
			.limit(1);
		if (!belongsToBackfillRun(row[0]?.backfillSource, runId)) {
			delta.skipped += 1;
			continue;
		}
		try {
			await db.delete(tenancies).where(eq(tenancies.id, tenancyId));
			delta.tenanciesMapped += 1;
		} catch {
			delta.errors += 1;
		}
	}

	for (const managedTenantId of [...checkpoint.created.managedTenantIds].reverse()) {
		delta.scanned += 1;
		if (!commit) {
			delta.skipped += 1;
			continue;
		}
		const row = await db
			.select({ backfillSource: managedTenants.backfillSource })
			.from(managedTenants)
			.where(eq(managedTenants.id, managedTenantId))
			.limit(1);
		if (!belongsToBackfillRun(row[0]?.backfillSource, runId)) {
			delta.skipped += 1;
			continue;
		}
		try {
			await db.delete(managedTenants).where(eq(managedTenants.id, managedTenantId));
			delta.managedTenantsCreated += 1;
		} catch {
			delta.errors += 1;
		}
	}

	return delta;
}

export async function runBackfillTenancies(
	db: TenancyMigrationDb,
	opts: BackfillCliOptions
): Promise<{ runId: string; report: BackfillReport }> {
	assertBackfillEnvironmentAllowed(opts.commit);
	if (opts.landlordId) await validateLandlordId(db, opts.landlordId);

	if (opts.rollbackRunId) {
		const checkpoint = await loadCheckpoint(opts.checkpointDir, opts.rollbackRunId);
		if (!checkpoint) throw new Error(`Checkpoint not found for run ${opts.rollbackRunId}`);
		const report = await rollbackBackfillRun(db, checkpoint, opts.commit);
		return { runId: opts.rollbackRunId, report };
	}

	const runId = opts.resumeRunId ?? crypto.randomUUID();
	const checkpoint =
		(await loadCheckpoint(opts.checkpointDir, runId)) ?? newCheckpoint(opts, runId);

	const overlappingRooms = await loadOverlappingContractRooms(db, opts.landlordId);
	const tenancyCandidates = await loadTenancyCandidates(db, opts.landlordId);
	let processed = 0;
	const phases: BackfillPhase[] = [
		'managed_tenants',
		'tenancies_contract',
		'tenancies_current_room',
		'map_resources'
	];
	const startPhaseIdx = phases.indexOf(checkpoint.cursor.phase);

	for (let phaseIdx = Math.max(0, startPhaseIdx); phaseIdx < phases.length; phaseIdx++) {
		const phase = phases[phaseIdx]!;
		checkpoint.cursor.phase = phase;
		let batchDone = false;
		while (!batchDone && processed < opts.limit) {
			const remaining = opts.limit - processed;
			const batchOpts = { ...opts, batchSize: Math.min(opts.batchSize, remaining) };
			let result: { done: boolean; delta: BackfillReport };
			if (phase === 'managed_tenants') {
				result = await runManagedTenantBatch(db, checkpoint, batchOpts);
			} else if (phase === 'tenancies_contract') {
				result = await runContractTenancyBatch(db, checkpoint, batchOpts, overlappingRooms);
			} else if (phase === 'tenancies_current_room') {
				result = await runCurrentRoomTenancyBatch(db, checkpoint, batchOpts);
			} else {
				result = await runResourceMappingBatch(db, checkpoint, batchOpts, tenancyCandidates);
			}
			checkpoint.stats = mergeReport(checkpoint.stats, result.delta);
			processed += result.delta.scanned;
			batchDone = result.done;
			await saveCheckpoint(opts.checkpointDir, checkpoint);
			if (processed >= opts.limit) break;
		}
		checkpoint.cursor.lastId = null;
	}

	return { runId, report: checkpoint.stats };
}
