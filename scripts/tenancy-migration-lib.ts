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
	previousManagedTenantId: string | null;
	previousTenancyId: string | null;
};

export type RoomCompatibilitySnapshot = {
	roomId: string;
	previousCurrentManagedTenantId: string | null;
	writtenCurrentManagedTenantId: string;
};

export type BackfillInputScope = {
	landlordId: string | null;
	limit: number;
	batchSize: number;
};

export type DryRunVirtualPlan = {
	managedTenantByLegacyKey: Record<string, string>;
	tenancies: TenancyCandidate[];
};

export type BackfillCheckpoint = {
	schemaVersion: number;
	runId: string;
	startedAt: string;
	landlordId: string | null;
	dryRun: boolean;
	inputScope: BackfillInputScope;
	cursor: { phase: BackfillPhase; lastId: string | null };
	stats: BackfillReport;
	dryRunVirtual?: DryRunVirtualPlan;
	created: {
		managedTenantIds: string[];
		tenancyIds: string[];
		resourceMappings: ResourceMappingRecord[];
		roomCompatibilitySnapshots: RoomCompatibilitySnapshot[];
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
export const CHECKPOINT_SCHEMA_VERSION = 1;
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_CHECKPOINT_DIR = '.checkpoints/tenancy-backfill';

export function managedTenantLegacyKey(landlordId: string, legacyTenantProfileId: string): string {
	return `${landlordId}:${legacyTenantProfileId}`;
}

export function buildInputScope(opts: BackfillCliOptions): BackfillInputScope {
	return {
		landlordId: opts.landlordId ?? null,
		limit: opts.limit,
		batchSize: opts.batchSize
	};
}

export function validateCheckpointResumeContext(
	checkpoint: BackfillCheckpoint,
	opts: BackfillCliOptions
): void {
	if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
		throw new Error(
			`Checkpoint schemaVersion mismatch: expected ${CHECKPOINT_SCHEMA_VERSION}, got ${checkpoint.schemaVersion}`
		);
	}
	const expectedDryRun = !opts.commit;
	if (checkpoint.dryRun !== expectedDryRun) {
		throw new Error(
			`Checkpoint mode mismatch: checkpoint dryRun=${checkpoint.dryRun} but current mode is ${expectedDryRun ? 'dry-run' : 'commit'}`
		);
	}
	const expectedLandlord = opts.landlordId ?? null;
	if (checkpoint.landlordId !== expectedLandlord) {
		throw new Error(
			`Checkpoint landlordId mismatch: checkpoint=${checkpoint.landlordId ?? 'null'} current=${expectedLandlord ?? 'null'}`
		);
	}
	const currentScope = buildInputScope(opts);
	if (
		checkpoint.inputScope.landlordId !== currentScope.landlordId ||
		checkpoint.inputScope.limit !== currentScope.limit ||
		checkpoint.inputScope.batchSize !== currentScope.batchSize
	) {
		throw new Error('Checkpoint input scope mismatch (landlordId/limit/batchSize)');
	}
}

export function ensureDryRunVirtual(checkpoint: BackfillCheckpoint): DryRunVirtualPlan {
	if (!checkpoint.dryRunVirtual) {
		checkpoint.dryRunVirtual = { managedTenantByLegacyKey: {}, tenancies: [] };
	}
	return checkpoint.dryRunVirtual;
}

export function resolveTenancyCandidates(
	dbCandidates: TenancyCandidate[],
	checkpoint: BackfillCheckpoint
): TenancyCandidate[] {
	if (!checkpoint.dryRun) return dbCandidates;
	const virtual = ensureDryRunVirtual(checkpoint);
	const byId = new Map<string, TenancyCandidate>();
	for (const row of dbCandidates) byId.set(row.id, row);
	for (const row of virtual.tenancies) byId.set(row.id, row);
	return [...byId.values()];
}

export function canRollbackResourceMapping(
	mapping: ResourceMappingRecord,
	current: { managedTenantId: string | null; tenancyId: string | null }
): boolean {
	return (
		current.managedTenantId === mapping.managedTenantId && current.tenancyId === mapping.tenancyId
	);
}

export function canRollbackRoomCompatibility(
	snapshot: RoomCompatibilitySnapshot,
	currentCurrentManagedTenantId: string | null
): boolean {
	return currentCurrentManagedTenantId === snapshot.writtenCurrentManagedTenantId;
}

function ensureManagedTenantRecorded(checkpoint: BackfillCheckpoint, id: string): void {
	if (!checkpoint.created.managedTenantIds.includes(id)) {
		checkpoint.created.managedTenantIds.push(id);
	}
}

function ensureTenancyRecorded(checkpoint: BackfillCheckpoint, id: string): void {
	if (!checkpoint.created.tenancyIds.includes(id)) {
		checkpoint.created.tenancyIds.push(id);
	}
}

function ensureResourceMappingRecorded(
	checkpoint: BackfillCheckpoint,
	mapping: ResourceMappingRecord
): void {
	if (
		!checkpoint.created.resourceMappings.some(
			(m) => m.table === mapping.table && m.id === mapping.id
		)
	) {
		checkpoint.created.resourceMappings.push(mapping);
	}
}

function ensureRoomSnapshotRecorded(
	checkpoint: BackfillCheckpoint,
	snapshot: RoomCompatibilitySnapshot
): void {
	if (!checkpoint.created.roomCompatibilitySnapshots.some((s) => s.roomId === snapshot.roomId)) {
		checkpoint.created.roomCompatibilitySnapshots.push(snapshot);
	}
}

async function recognizeAppliedContractMapping(
	db: TenancyMigrationDb,
	checkpoint: BackfillCheckpoint,
	contractId: string
): Promise<boolean> {
	const rows = await db
		.select({
			managedTenantId: contracts.managedTenantId,
			tenancyId: contracts.tenancyId,
			backfillSource: tenancies.backfillSource
		})
		.from(contracts)
		.leftJoin(tenancies, eq(contracts.tenancyId, tenancies.id))
		.where(eq(contracts.id, contractId))
		.limit(1);
	const row = rows[0];
	if (!row?.tenancyId || !belongsToBackfillRun(row.backfillSource, checkpoint.runId)) {
		return false;
	}
	ensureTenancyRecorded(checkpoint, row.tenancyId);
	ensureResourceMappingRecorded(checkpoint, {
		table: 'Contract',
		id: contractId,
		managedTenantId: row.managedTenantId,
		tenancyId: row.tenancyId,
		previousManagedTenantId: null,
		previousTenancyId: null
	});
	return true;
}

async function recognizeAppliedCurrentRoomTenancy(
	db: TenancyMigrationDb,
	checkpoint: BackfillCheckpoint,
	roomId: string,
	expectedManagedTenantId: string
): Promise<boolean> {
	const activeTenancy = await db
		.select({ id: tenancies.id, backfillSource: tenancies.backfillSource })
		.from(tenancies)
		.where(and(eq(tenancies.roomId, roomId), eq(tenancies.status, 'ACTIVE')))
		.limit(1);
	if (
		activeTenancy.length === 0 ||
		!belongsToBackfillRun(activeTenancy[0]!.backfillSource, checkpoint.runId)
	) {
		return false;
	}
	ensureTenancyRecorded(checkpoint, activeTenancy[0]!.id);
	const room = (
		await db
			.select({ currentManagedTenantId: rooms.currentManagedTenantId })
			.from(rooms)
			.where(eq(rooms.id, roomId))
			.limit(1)
	)[0];
	if (room?.currentManagedTenantId === expectedManagedTenantId) {
		ensureRoomSnapshotRecorded(checkpoint, {
			roomId,
			previousCurrentManagedTenantId: null,
			writtenCurrentManagedTenantId: expectedManagedTenantId
		});
	}
	return true;
}

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

export function backfillManagedTenantClaimFields(): {
	claimedByUserId: null;
	claimVersion: 0;
} {
	// Legacy TenantProfile.userId is not verified linkage; claim stays null until AUTH-009 invite flow.
	return { claimedByUserId: null, claimVersion: 0 };
}

export function shouldReloadTenancyCandidatesAtPhaseStart(phase: BackfillPhase): boolean {
	return phase === 'map_resources';
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
	await fs.mkdir(checkpointDir, { recursive: true, mode: 0o700 });
	const filePath = checkpointPath(checkpointDir, checkpoint.runId);
	const tmpPath = `${filePath}.tmp.${process.pid}`;
	const payload = JSON.stringify(checkpoint, null, 2);
	await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
	await fs.rename(tmpPath, filePath);
	await fs.chmod(filePath, 0o600);
}

export function newCheckpoint(opts: BackfillCliOptions, runId: string): BackfillCheckpoint {
	return {
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		runId,
		startedAt: new Date().toISOString(),
		landlordId: opts.landlordId ?? null,
		dryRun: !opts.commit,
		inputScope: buildInputScope(opts),
		cursor: { phase: 'managed_tenants', lastId: null },
		stats: { ...EMPTY_REPORT },
		created: {
			managedTenantIds: [],
			tenancyIds: [],
			resourceMappings: [],
			roomCompatibilitySnapshots: []
		}
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
		const legacyKey = managedTenantLegacyKey(row.landlordId, row.legacyTenantProfileId);

		if (checkpoint.dryRun) {
			const virtual = ensureDryRunVirtual(checkpoint);
			if (virtual.managedTenantByLegacyKey[legacyKey]) {
				delta.skipped += 1;
				continue;
			}
			const managedTenantId = crypto.randomUUID();
			virtual.managedTenantByLegacyKey[legacyKey] = managedTenantId;
			delta.managedTenantsCreated += 1;
			ensureManagedTenantRecorded(checkpoint, managedTenantId);
			continue;
		}

		const existing = await db
			.select({
				id: managedTenants.id,
				backfillSource: managedTenants.backfillSource
			})
			.from(managedTenants)
			.where(
				and(
					eq(managedTenants.landlordId, row.landlordId),
					eq(managedTenants.legacyTenantProfileId, row.legacyTenantProfileId)
				)
			)
			.limit(1);

		if (existing.length > 0) {
			if (belongsToBackfillRun(existing[0]!.backfillSource, checkpoint.runId)) {
				ensureManagedTenantRecorded(checkpoint, existing[0]!.id);
			}
			delta.skipped += 1;
			continue;
		}

		const managedTenantId = crypto.randomUUID();
		const backfillSource = buildBackfillSource(checkpoint.runId, 'LEGACY_TENANT_PROFILE');
		const { claimedByUserId, claimVersion } = backfillManagedTenantClaimFields();

		try {
			const inserted = await db
				.insert(managedTenants)
				.values({
					id: managedTenantId,
					landlordId: row.landlordId,
					displayName: row.displayName,
					emailSnapshot: row.email,
					phoneSnapshot: row.phone,
					claimedByUserId,
					claimVersion,
					status: 'ACTIVE',
					legacyTenantProfileId: row.legacyTenantProfileId,
					backfillSource,
					needsReview: false,
					createdByActorType: 'SYSTEM',
					createdByUserId: null
				})
				.returning({ id: managedTenants.id });
			if (inserted.length === 1) {
				delta.managedTenantsCreated += 1;
				ensureManagedTenantRecorded(checkpoint, inserted[0]!.id);
			} else {
				delta.errors += 1;
			}
		} catch {
			const existing = await db
				.select({
					id: managedTenants.id,
					backfillSource: managedTenants.backfillSource
				})
				.from(managedTenants)
				.where(
					and(
						eq(managedTenants.landlordId, row.landlordId),
						eq(managedTenants.legacyTenantProfileId, row.legacyTenantProfileId)
					)
				)
				.limit(1);
			if (
				existing.length > 0 &&
				belongsToBackfillRun(existing[0]!.backfillSource, checkpoint.runId)
			) {
				ensureManagedTenantRecorded(checkpoint, existing[0]!.id);
				delta.skipped += 1;
			} else {
				delta.errors += 1;
			}
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
			if (await recognizeAppliedContractMapping(db, checkpoint, row.contractId)) {
				delta.skipped += 1;
				continue;
			}
			delta.skipped += 1;
			continue;
		}
		if (overlappingRooms.has(row.roomId)) {
			delta.unresolved += 1;
			continue;
		}

		let managedTenantId: string | null = null;
		if (checkpoint.dryRun) {
			const virtual = ensureDryRunVirtual(checkpoint);
			managedTenantId =
				virtual.managedTenantByLegacyKey[managedTenantLegacyKey(row.landlordId, row.tenantId)] ??
				null;
		} else {
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
			managedTenantId = managed[0]?.id ?? null;
		}
		if (!managedTenantId) {
			delta.unresolved += 1;
			continue;
		}

		const tenancyId = crypto.randomUUID();
		const isActive =
			row.status === 'active' && row.endDate >= new Date().toISOString().slice(0, 10);
		const backfillSource = buildBackfillSource(checkpoint.runId, 'CONTRACT');

		if (checkpoint.dryRun) {
			const virtual = ensureDryRunVirtual(checkpoint);
			virtual.tenancies.push({
				id: tenancyId,
				managedTenantId,
				roomId: row.roomId,
				startDate: row.startDate,
				endDate: isActive ? null : row.endDate,
				status: isActive ? 'ACTIVE' : 'ENDED',
				backfillSource
			});
			delta.tenanciesMapped += 1;
			ensureTenancyRecorded(checkpoint, tenancyId);
			continue;
		}

		try {
			const txResult = await db.transaction(async (tx) => {
				const inserted = await tx
					.insert(tenancies)
					.values({
						id: tenancyId,
						landlordId: row.landlordId,
						propertyId: row.propertyId,
						roomId: row.roomId,
						managedTenantId,
						status: isActive ? 'ACTIVE' : 'ENDED',
						startDate: row.startDate,
						plannedEndDate: row.endDate,
						endDate: isActive ? null : row.endDate,
						depositRequired: 0,
						backfillSource,
						needsReview: false,
						createdByActorType: 'SYSTEM',
						createdByUserId: null
					})
					.returning({ id: tenancies.id });
				if (inserted.length !== 1) return null;

				const updated = await tx
					.update(contracts)
					.set({
						managedTenantId,
						tenancyId
					})
					.where(and(eq(contracts.id, row.contractId), isNull(contracts.tenancyId)))
					.returning({ id: contracts.id });
				if (updated.length !== 1) return null;
				return { ok: true as const };
			});
			if (!txResult) {
				if (await recognizeAppliedContractMapping(db, checkpoint, row.contractId)) {
					delta.skipped += 1;
				} else {
					delta.errors += 1;
				}
				continue;
			}
			delta.tenanciesMapped += 1;
			ensureTenancyRecorded(checkpoint, tenancyId);
			ensureResourceMappingRecorded(checkpoint, {
				table: 'Contract',
				id: row.contractId,
				managedTenantId,
				tenancyId,
				previousManagedTenantId: null,
				previousTenancyId: null
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

		let managedTenantId: string | null = null;
		if (checkpoint.dryRun) {
			const virtual = ensureDryRunVirtual(checkpoint);
			managedTenantId =
				virtual.managedTenantByLegacyKey[managedTenantLegacyKey(row.landlordId, row.tenantId)] ??
				null;
		} else {
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
			managedTenantId = managed[0]?.id ?? null;
		}

		const activeTenancy = await db
			.select({ id: tenancies.id, backfillSource: tenancies.backfillSource })
			.from(tenancies)
			.where(and(eq(tenancies.roomId, row.roomId), eq(tenancies.status, 'ACTIVE')))
			.limit(1);
		if (activeTenancy.length > 0) {
			if (
				managedTenantId &&
				(await recognizeAppliedCurrentRoomTenancy(db, checkpoint, row.roomId, managedTenantId))
			) {
				delta.skipped += 1;
				continue;
			}
			if (belongsToBackfillRun(activeTenancy[0]!.backfillSource, checkpoint.runId)) {
				ensureTenancyRecorded(checkpoint, activeTenancy[0]!.id);
			}
			delta.skipped += 1;
			continue;
		}

		if (!managedTenantId) {
			delta.unresolved += 1;
			continue;
		}

		if (!row.moveInDate) {
			delta.unresolved += 1;
			continue;
		}

		const tenancyId = crypto.randomUUID();
		const backfillSource = buildBackfillSource(checkpoint.runId, 'CURRENT_ROOM');

		if (checkpoint.dryRun) {
			const virtual = ensureDryRunVirtual(checkpoint);
			virtual.tenancies.push({
				id: tenancyId,
				managedTenantId,
				roomId: row.roomId,
				startDate: row.moveInDate,
				endDate: null,
				status: 'ACTIVE',
				backfillSource
			});
			delta.tenanciesMapped += 1;
			ensureTenancyRecorded(checkpoint, tenancyId);
			continue;
		}

		const roomBefore = await db
			.select({ currentManagedTenantId: rooms.currentManagedTenantId })
			.from(rooms)
			.where(eq(rooms.id, row.roomId))
			.limit(1);
		const previousCurrentManagedTenantId = roomBefore[0]?.currentManagedTenantId ?? null;

		try {
			const txResult = await db.transaction(async (tx) => {
				const inserted = await tx
					.insert(tenancies)
					.values({
						id: tenancyId,
						landlordId: row.landlordId,
						propertyId: row.propertyId,
						roomId: row.roomId,
						managedTenantId,
						status: 'ACTIVE',
						startDate: row.moveInDate!,
						depositRequired: 0,
						backfillSource,
						needsReview: true,
						createdByActorType: 'SYSTEM',
						createdByUserId: null
					})
					.returning({ id: tenancies.id });
				if (inserted.length !== 1) return null;

				const updated = await tx
					.update(rooms)
					.set({ currentManagedTenantId: managedTenantId })
					.where(eq(rooms.id, row.roomId))
					.returning({ id: rooms.id });
				if (updated.length !== 1) return null;
				return { ok: true as const };
			});
			if (!txResult) {
				if (await recognizeAppliedCurrentRoomTenancy(db, checkpoint, row.roomId, managedTenantId)) {
					delta.skipped += 1;
				} else {
					delta.errors += 1;
				}
				continue;
			}
			delta.tenanciesMapped += 1;
			ensureTenancyRecorded(checkpoint, tenancyId);
			ensureRoomSnapshotRecorded(checkpoint, {
				roomId: row.roomId,
				previousCurrentManagedTenantId,
				writtenCurrentManagedTenantId: managedTenantId
			});
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

		if (checkpoint.dryRun) {
			delta.tenanciesMapped += 1;
			continue;
		}

		try {
			const updated = await db
				.update(invoices)
				.set({
					managedTenantId: decision.managedTenantId,
					tenancyId: decision.tenancyId
				})
				.where(and(eq(invoices.id, row.id), isNull(invoices.tenancyId)))
				.returning({ id: invoices.id });
			if (updated.length !== 1) {
				const current = await db
					.select({
						managedTenantId: invoices.managedTenantId,
						tenancyId: invoices.tenancyId
					})
					.from(invoices)
					.where(eq(invoices.id, row.id))
					.limit(1);
				if (
					current[0]?.managedTenantId === decision.managedTenantId &&
					current[0]?.tenancyId === decision.tenancyId
				) {
					delta.skipped += 1;
					ensureResourceMappingRecorded(checkpoint, {
						table: 'Invoice',
						id: row.id,
						managedTenantId: decision.managedTenantId,
						tenancyId: decision.tenancyId,
						previousManagedTenantId: row.managedTenantId,
						previousTenancyId: row.tenancyId
					});
				} else {
					delta.errors += 1;
				}
				continue;
			}
			delta.tenanciesMapped += 1;
			ensureResourceMappingRecorded(checkpoint, {
				table: 'Invoice',
				id: row.id,
				managedTenantId: decision.managedTenantId,
				tenancyId: decision.tenancyId,
				previousManagedTenantId: row.managedTenantId,
				previousTenancyId: row.tenancyId
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

/** Stable finding codes emitted by `runTenancyReconciliation` (for tests and runbook). */
export function expectedReconcileFindingCodes(): string[] {
	const codes = ['DUPLICATE_ACTIVE_TENANCY_PER_ROOM', 'OVERLAPPING_CONTRACT_WINDOWS'];
	const resourceCodes = [
		[
			'UNSCOPED_INVOICES',
			'PARTIAL_SCOPE_INVOICE',
			'ORPHAN_SCOPE_INVOICE',
			'INVOICE_OUTSIDE_TENANCY_RANGE'
		],
		[
			'UNSCOPED_CONTRACTS',
			'PARTIAL_SCOPE_CONTRACT',
			'ORPHAN_SCOPE_CONTRACT',
			'CONTRACT_OUTSIDE_TENANCY_RANGE'
		],
		[
			'UNSCOPED_METER_READINGS',
			'PARTIAL_SCOPE_METER_READING',
			'ORPHAN_SCOPE_METER_READING',
			'METER_READING_OUTSIDE_TENANCY_RANGE'
		],
		[
			'UNSCOPED_MAINTENANCE_REQUESTS',
			'PARTIAL_SCOPE_MAINTENANCE_REQUEST',
			'ORPHAN_SCOPE_MAINTENANCE_REQUEST'
		]
	] as const;
	for (const group of resourceCodes) {
		codes.push(...group);
	}
	return codes;
}

export async function runTenancyReconciliation(
	db: TenancyMigrationDb,
	landlordId?: string
): Promise<ReconcileFinding[]> {
	if (landlordId) await validateLandlordId(db, landlordId);

	const findings: ReconcileFinding[] = [];
	const landlordFilter = landlordId ? eq(properties.landlordId, landlordId) : undefined;
	const tenancyLandlordFilter = landlordId ? eq(tenancies.landlordId, landlordId) : undefined;

	const duplicateActiveRooms = await db
		.select({ roomId: tenancies.roomId })
		.from(tenancies)
		.where(and(eq(tenancies.status, 'ACTIVE'), tenancyLandlordFilter))
		.groupBy(tenancies.roomId)
		.having(sql`count(*) > 1`);

	findings.push({
		code: 'DUPLICATE_ACTIVE_TENANCY_PER_ROOM',
		count: duplicateActiveRooms.length,
		sampleIds: duplicateActiveRooms.map((r) => r.roomId).slice(0, 20)
	});

	const overlappingRooms = await loadOverlappingContractRooms(db, landlordId);
	findings.push({
		code: 'OVERLAPPING_CONTRACT_WINDOWS',
		count: overlappingRooms.size,
		sampleIds: [...overlappingRooms].slice(0, 20)
	});

	const resourceTables = [
		{
			code: 'UNSCOPED_INVOICES',
			partialCode: 'PARTIAL_SCOPE_INVOICE',
			orphanCode: 'ORPHAN_SCOPE_INVOICE',
			outsideCode: 'INVOICE_OUTSIDE_TENANCY_RANGE',
			table: invoices,
			idCol: invoices.id,
			roomJoin: true,
			dateExpr: sql`(${invoices.month} || '-01')::date`
		},
		{
			code: 'UNSCOPED_CONTRACTS',
			partialCode: 'PARTIAL_SCOPE_CONTRACT',
			orphanCode: 'ORPHAN_SCOPE_CONTRACT',
			outsideCode: 'CONTRACT_OUTSIDE_TENANCY_RANGE',
			table: contracts,
			idCol: contracts.id,
			roomJoin: true,
			dateExpr: sql`${contracts.startDate}::date`
		},
		{
			code: 'UNSCOPED_METER_READINGS',
			partialCode: 'PARTIAL_SCOPE_METER_READING',
			orphanCode: 'ORPHAN_SCOPE_METER_READING',
			outsideCode: 'METER_READING_OUTSIDE_TENANCY_RANGE',
			table: meterReadings,
			idCol: meterReadings.id,
			roomJoin: true,
			dateExpr: sql`(${meterReadings.month} || '-01')::date`
		},
		{
			code: 'UNSCOPED_MAINTENANCE_REQUESTS',
			partialCode: 'PARTIAL_SCOPE_MAINTENANCE_REQUEST',
			orphanCode: 'ORPHAN_SCOPE_MAINTENANCE_REQUEST',
			outsideCode: null,
			table: maintenanceRequests,
			idCol: maintenanceRequests.id,
			roomJoin: false,
			dateExpr: null
		}
	] as const;

	for (const resource of resourceTables) {
		const unscopedWhere = and(
			isNull(resource.table.managedTenantId),
			isNull(resource.table.tenancyId),
			resource.roomJoin && landlordFilter ? eq(properties.landlordId, landlordId!) : undefined
		);

		const unscopedCountQuery = resource.roomJoin
			? db
					.select({ count: sql<number>`count(*)::int` })
					.from(resource.table)
					.innerJoin(rooms, eq(resource.table.roomId, rooms.id))
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(unscopedWhere)
			: db
					.select({ count: sql<number>`count(*)::int` })
					.from(resource.table)
					.where(and(isNull(resource.table.managedTenantId), isNull(resource.table.tenancyId)));

		const [unscopedCount] = await unscopedCountQuery;
		const unscopedSamples = resource.roomJoin
			? await db
					.select({ id: resource.idCol })
					.from(resource.table)
					.innerJoin(rooms, eq(resource.table.roomId, rooms.id))
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(unscopedWhere)
					.limit(20)
			: await db
					.select({ id: resource.idCol })
					.from(resource.table)
					.where(and(isNull(resource.table.managedTenantId), isNull(resource.table.tenancyId)))
					.limit(20);

		findings.push({
			code: resource.code,
			count: unscopedCount?.count ?? 0,
			sampleIds: unscopedSamples.map((r) => r.id)
		});

		const partialWhere = and(
			or(isNotNull(resource.table.managedTenantId), isNotNull(resource.table.tenancyId)),
			or(isNull(resource.table.managedTenantId), isNull(resource.table.tenancyId)),
			resource.roomJoin && landlordFilter ? eq(properties.landlordId, landlordId!) : undefined
		);

		const [partialCount] = resource.roomJoin
			? await db
					.select({ count: sql<number>`count(*)::int` })
					.from(resource.table)
					.innerJoin(rooms, eq(resource.table.roomId, rooms.id))
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(partialWhere)
			: await db
					.select({ count: sql<number>`count(*)::int` })
					.from(resource.table)
					.where(
						and(
							or(isNotNull(resource.table.managedTenantId), isNotNull(resource.table.tenancyId)),
							or(isNull(resource.table.managedTenantId), isNull(resource.table.tenancyId))
						)
					);

		const partialSamples = resource.roomJoin
			? await db
					.select({ id: resource.idCol })
					.from(resource.table)
					.innerJoin(rooms, eq(resource.table.roomId, rooms.id))
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(partialWhere)
					.limit(20)
			: await db
					.select({ id: resource.idCol })
					.from(resource.table)
					.where(
						and(
							or(isNotNull(resource.table.managedTenantId), isNotNull(resource.table.tenancyId)),
							or(isNull(resource.table.managedTenantId), isNull(resource.table.tenancyId))
						)
					)
					.limit(20);

		findings.push({
			code: resource.partialCode,
			count: partialCount?.count ?? 0,
			sampleIds: partialSamples.map((r) => r.id)
		});

		const orphanWhere = and(
			isNotNull(resource.table.managedTenantId),
			isNotNull(resource.table.tenancyId),
			sql`${resource.table.managedTenantId} <> ${tenancies.managedTenantId}`,
			tenancyLandlordFilter
		);

		const [orphanCount] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(resource.table)
			.innerJoin(tenancies, eq(resource.table.tenancyId, tenancies.id))
			.where(orphanWhere);

		const orphanSamples = await db
			.select({ id: resource.idCol })
			.from(resource.table)
			.innerJoin(tenancies, eq(resource.table.tenancyId, tenancies.id))
			.where(orphanWhere)
			.limit(20);

		findings.push({
			code: resource.orphanCode,
			count: orphanCount?.count ?? 0,
			sampleIds: orphanSamples.map((r) => r.id)
		});

		if (resource.dateExpr && resource.outsideCode) {
			const outsideWhere = and(
				isNotNull(resource.table.tenancyId),
				sql`${resource.dateExpr} < ${tenancies.startDate}
          OR ${resource.dateExpr} > COALESCE(${tenancies.endDate}, '9999-12-31'::date)`,
				tenancyLandlordFilter
			);

			const [outsideCount] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(resource.table)
				.innerJoin(tenancies, eq(resource.table.tenancyId, tenancies.id))
				.where(outsideWhere);

			const outsideSamples = await db
				.select({ id: resource.idCol })
				.from(resource.table)
				.innerJoin(tenancies, eq(resource.table.tenancyId, tenancies.id))
				.where(outsideWhere)
				.limit(20);

			findings.push({
				code: resource.outsideCode,
				count: outsideCount?.count ?? 0,
				sampleIds: outsideSamples.map((r) => r.id)
			});
		}
	}

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
			let current: { managedTenantId: string | null; tenancyId: string | null } | undefined;
			if (mapping.table === 'Invoice') {
				current = (
					await db
						.select({
							managedTenantId: invoices.managedTenantId,
							tenancyId: invoices.tenancyId
						})
						.from(invoices)
						.where(eq(invoices.id, mapping.id))
						.limit(1)
				)[0];
			} else if (mapping.table === 'Contract') {
				current = (
					await db
						.select({
							managedTenantId: contracts.managedTenantId,
							tenancyId: contracts.tenancyId
						})
						.from(contracts)
						.where(eq(contracts.id, mapping.id))
						.limit(1)
				)[0];
			} else if (mapping.table === 'MeterReading') {
				current = (
					await db
						.select({
							managedTenantId: meterReadings.managedTenantId,
							tenancyId: meterReadings.tenancyId
						})
						.from(meterReadings)
						.where(eq(meterReadings.id, mapping.id))
						.limit(1)
				)[0];
			} else {
				current = (
					await db
						.select({
							managedTenantId: maintenanceRequests.managedTenantId,
							tenancyId: maintenanceRequests.tenancyId
						})
						.from(maintenanceRequests)
						.where(eq(maintenanceRequests.id, mapping.id))
						.limit(1)
				)[0];
			}
			if (!current || !canRollbackResourceMapping(mapping, current)) {
				delta.skipped += 1;
				continue;
			}

			if (mapping.table === 'Invoice') {
				await db
					.update(invoices)
					.set({
						managedTenantId: mapping.previousManagedTenantId,
						tenancyId: mapping.previousTenancyId
					})
					.where(eq(invoices.id, mapping.id));
			} else if (mapping.table === 'Contract') {
				await db
					.update(contracts)
					.set({
						managedTenantId: mapping.previousManagedTenantId,
						tenancyId: mapping.previousTenancyId
					})
					.where(eq(contracts.id, mapping.id));
			} else if (mapping.table === 'MeterReading') {
				await db
					.update(meterReadings)
					.set({
						managedTenantId: mapping.previousManagedTenantId,
						tenancyId: mapping.previousTenancyId
					})
					.where(eq(meterReadings.id, mapping.id));
			} else {
				await db
					.update(maintenanceRequests)
					.set({
						managedTenantId: mapping.previousManagedTenantId,
						tenancyId: mapping.previousTenancyId
					})
					.where(eq(maintenanceRequests.id, mapping.id));
			}
			delta.tenanciesMapped += 1;
		} catch {
			delta.errors += 1;
		}
	}

	for (const snapshot of [...checkpoint.created.roomCompatibilitySnapshots].reverse()) {
		delta.scanned += 1;
		if (!commit) {
			delta.skipped += 1;
			continue;
		}
		try {
			const room = (
				await db
					.select({ currentManagedTenantId: rooms.currentManagedTenantId })
					.from(rooms)
					.where(eq(rooms.id, snapshot.roomId))
					.limit(1)
			)[0];
			if (!room || !canRollbackRoomCompatibility(snapshot, room.currentManagedTenantId)) {
				delta.skipped += 1;
				continue;
			}
			await db
				.update(rooms)
				.set({ currentManagedTenantId: snapshot.previousCurrentManagedTenantId })
				.where(eq(rooms.id, snapshot.roomId));
			delta.skipped += 1;
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
	const loaded = opts.resumeRunId ? await loadCheckpoint(opts.checkpointDir, runId) : null;
	if (opts.resumeRunId && !loaded) {
		throw new Error(`Checkpoint not found for run ${opts.resumeRunId}`);
	}
	const checkpoint = loaded ?? newCheckpoint(opts, runId);
	if (loaded) {
		validateCheckpointResumeContext(checkpoint, opts);
	}

	const overlappingRooms = await loadOverlappingContractRooms(db, opts.landlordId);
	let tenancyCandidates: TenancyCandidate[] = [];
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
		if (shouldReloadTenancyCandidatesAtPhaseStart(phase)) {
			const dbCandidates = await loadTenancyCandidates(db, opts.landlordId);
			tenancyCandidates = resolveTenancyCandidates(dbCandidates, checkpoint);
		}
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
