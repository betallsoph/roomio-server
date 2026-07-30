import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
	assertBackfillEnvironmentAllowed,
	backfillManagedTenantClaimFields,
	belongsToBackfillRun,
	buildBackfillSource,
	buildInputScope,
	canRollbackResourceMapping,
	canRollbackRoomCompatibility,
	checkpointPath,
	contactFingerprint,
	datesOverlap,
	decideResourceMapping,
	detectOverlappingContracts,
	ensureDryRunVirtual,
	expectedReconcileFindingCodes,
	findTenancyForDate,
	findVirtualActiveTenancyForRoom,
	loadCheckpoint,
	mergeReport,
	newCheckpoint,
	parseBackfillCliArgs,
	parseBackfillSource,
	resolveTenancyCandidates,
	rollbackBackfillRun,
	runCurrentRoomTenancyBatch,
	saveCheckpoint,
	shouldReloadTenancyCandidatesAtPhaseStart,
	validateCheckpointResumeContext,
	CHECKPOINT_SCHEMA_VERSION,
	type BackfillCheckpoint,
	type TenancyCandidate,
	type TenancyMigrationDb
} from './tenancy-migration-lib.js';

function sampleCheckpoint(overrides: Partial<BackfillCheckpoint> = {}): BackfillCheckpoint {
	return {
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		runId: 'run-1',
		startedAt: '2026-07-30T00:00:00.000Z',
		landlordId: 'landlord-a',
		dryRun: true,
		inputScope: { landlordId: 'landlord-a', limit: 100, batchSize: 10 },
		cursor: { phase: 'managed_tenants', lastId: null },
		stats: {
			scanned: 0,
			managedTenantsCreated: 0,
			claimed: 0,
			tenanciesMapped: 0,
			unresolved: 0,
			skipped: 0,
			errors: 0
		},
		created: {
			managedTenantIds: [],
			tenancyIds: [],
			resourceMappings: [],
			roomCompatibilitySnapshots: []
		},
		...overrides
	};
}

describe('AUTH-007 tenancy migration lib', () => {
	it('parseBackfillCliArgs defaults to dry-run', () => {
		const opts = parseBackfillCliArgs(['--limit', '50']);
		assert.equal(opts.commit, false);
		assert.equal(opts.limit, 50);
	});

	it('parseBackfillCliArgs rejects invalid batch size', () => {
		assert.throws(() => parseBackfillCliArgs(['--batch-size', '0']));
	});

	it('assertBackfillEnvironmentAllowed blocks production', () => {
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			assert.throws(() => assertBackfillEnvironmentAllowed(false));
		} finally {
			process.env.NODE_ENV = prev;
		}
	});

	it('assertBackfillEnvironmentAllowed requires allowlist for commit', () => {
		const prevEnv = process.env.NODE_ENV;
		const prevAllow = process.env.BACKFILL_TENANCY_ENV_ALLOWLIST;
		process.env.NODE_ENV = 'development';
		delete process.env.BACKFILL_TENANCY_ENV_ALLOWLIST;
		try {
			assert.throws(() => assertBackfillEnvironmentAllowed(true));
			process.env.BACKFILL_TENANCY_ENV_ALLOWLIST = 'development,staging';
			assert.doesNotThrow(() => assertBackfillEnvironmentAllowed(true));
		} finally {
			process.env.NODE_ENV = prevEnv;
			if (prevAllow === undefined) delete process.env.BACKFILL_TENANCY_ENV_ALLOWLIST;
			else process.env.BACKFILL_TENANCY_ENV_ALLOWLIST = prevAllow;
		}
	});

	it('buildBackfillSource and parseBackfillSource round-trip', () => {
		const value = buildBackfillSource('run-1', 'CONTRACT');
		assert.deepEqual(parseBackfillSource(value), { runId: 'run-1', source: 'CONTRACT' });
	});

	it('contactFingerprint hashes without exposing raw contact', () => {
		const a = contactFingerprint('a@example.com', '0901234567');
		const b = contactFingerprint('a@example.com', '0901234567');
		const c = contactFingerprint('b@example.com', '0901234567');
		assert.ok(a);
		assert.equal(a, b);
		assert.notEqual(a, c);
		assert.match(a!, /^[a-f0-9]{64}$/);
	});

	it('datesOverlap detects overlapping contract windows', () => {
		assert.equal(datesOverlap('2024-01-01', '2024-06-30', '2024-06-01', '2024-12-31'), true);
		assert.equal(datesOverlap('2024-01-01', '2024-03-31', '2024-04-01', '2024-12-31'), false);
	});

	it('detectOverlappingContracts flags room with overlap', () => {
		const rooms = detectOverlappingContracts([
			{
				id: 'c1',
				roomId: 'room-a',
				tenantId: 't1',
				startDate: '2024-01-01',
				endDate: '2024-06-30',
				status: 'active'
			},
			{
				id: 'c2',
				roomId: 'room-a',
				tenantId: 't2',
				startDate: '2024-06-01',
				endDate: '2024-12-31',
				status: 'active'
			}
		]);
		assert.equal(rooms.has('room-a'), true);
	});

	it('findTenancyForDate returns ambiguous for multiple candidates', () => {
		const candidates: TenancyCandidate[] = [
			{
				id: 'ten-1',
				managedTenantId: 'mt-1',
				roomId: 'room-a',
				startDate: '2024-01-01',
				endDate: '2024-06-30',
				status: 'ENDED',
				backfillSource: 'AUTH007:run:CONTRACT'
			},
			{
				id: 'ten-2',
				managedTenantId: 'mt-2',
				roomId: 'room-a',
				startDate: '2024-05-01',
				endDate: null,
				status: 'ACTIVE',
				backfillSource: 'AUTH007:run:CONTRACT'
			}
		];
		assert.equal(findTenancyForDate(candidates, 'room-a', '2024-05-15'), 'ambiguous');
	});

	it('decideResourceMapping refuses invoice without contract-backed tenancy', () => {
		const candidates: TenancyCandidate[] = [
			{
				id: 'ten-1',
				managedTenantId: 'mt-1',
				roomId: 'room-a',
				startDate: '2024-01-01',
				endDate: null,
				status: 'ACTIVE',
				backfillSource: 'AUTH007:run:CURRENT_ROOM'
			}
		];
		const decision = decideResourceMapping({
			roomId: 'room-a',
			eventDate: '2024-03-01',
			resourceKind: 'invoice',
			tenancyCandidates: candidates
		});
		assert.equal(decision.action, 'unresolved');
		if (decision.action === 'unresolved') {
			assert.equal(decision.reason, 'ROOM_OCCUPANT_WITHOUT_CONTRACT');
		}
	});

	it('decideResourceMapping maps invoice when contract tenancy covers date', () => {
		const candidates: TenancyCandidate[] = [
			{
				id: 'ten-1',
				managedTenantId: 'mt-1',
				roomId: 'room-a',
				startDate: '2024-01-01',
				endDate: null,
				status: 'ACTIVE',
				backfillSource: 'AUTH007:run:CONTRACT'
			}
		];
		const decision = decideResourceMapping({
			roomId: 'room-a',
			eventDate: '2024-03-01',
			resourceKind: 'invoice',
			tenancyCandidates: candidates
		});
		assert.deepEqual(decision, {
			action: 'map',
			tenancyId: 'ten-1',
			managedTenantId: 'mt-1'
		});
	});

	it('backfillManagedTenantClaimFields never auto-claims from legacy userId', () => {
		assert.deepEqual(backfillManagedTenantClaimFields(), {
			claimedByUserId: null,
			claimVersion: 0
		});
		assert.deepEqual(backfillManagedTenantClaimFields(), backfillManagedTenantClaimFields());
	});

	it('shouldReloadTenancyCandidatesAtPhaseStart reloads only for map_resources', () => {
		assert.equal(shouldReloadTenancyCandidatesAtPhaseStart('map_resources'), true);
		assert.equal(shouldReloadTenancyCandidatesAtPhaseStart('managed_tenants'), false);
		assert.equal(shouldReloadTenancyCandidatesAtPhaseStart('tenancies_contract'), false);
		assert.equal(shouldReloadTenancyCandidatesAtPhaseStart('tenancies_current_room'), false);
	});

	it('mergeReport sums counters', () => {
		const merged = mergeReport(
			{
				scanned: 1,
				managedTenantsCreated: 2,
				claimed: 1,
				tenanciesMapped: 0,
				unresolved: 0,
				skipped: 0,
				errors: 0
			},
			{ scanned: 3, unresolved: 1 }
		);
		assert.equal(merged.scanned, 4);
		assert.equal(merged.unresolved, 1);
	});

	it('validateCheckpointResumeContext rejects mode mismatch', () => {
		const checkpoint = sampleCheckpoint({ dryRun: true });
		const commitOpts = parseBackfillCliArgs([
			'--commit',
			'--landlord-id',
			'landlord-a',
			'--limit',
			'100',
			'--batch-size',
			'10'
		]);
		assert.throws(
			() => validateCheckpointResumeContext(checkpoint, commitOpts),
			/Checkpoint mode mismatch/
		);
	});

	it('validateCheckpointResumeContext rejects landlord and input scope mismatch', () => {
		const checkpoint = sampleCheckpoint();
		const wrongLandlord = parseBackfillCliArgs([
			'--landlord-id',
			'landlord-b',
			'--limit',
			'100',
			'--batch-size',
			'10'
		]);
		assert.throws(
			() => validateCheckpointResumeContext(checkpoint, wrongLandlord),
			/landlordId mismatch/
		);

		const wrongLimit = parseBackfillCliArgs([
			'--landlord-id',
			'landlord-a',
			'--limit',
			'50',
			'--batch-size',
			'10'
		]);
		assert.throws(
			() => validateCheckpointResumeContext(checkpoint, wrongLimit),
			/input scope mismatch/
		);
	});

	it('dry-run virtual plan simulates later phases without DB tenancy rows', () => {
		const checkpoint = sampleCheckpoint({ dryRun: true });
		const virtual = ensureDryRunVirtual(checkpoint);
		virtual.managedTenantByLegacyKey['landlord-a:legacy-1'] = 'mt-virtual-1';
		virtual.tenancies.push({
			id: 'ten-virtual-1',
			managedTenantId: 'mt-virtual-1',
			roomId: 'room-a',
			startDate: '2024-01-01',
			endDate: null,
			status: 'ACTIVE',
			backfillSource: buildBackfillSource('run-1', 'CONTRACT')
		});

		const merged = resolveTenancyCandidates([], checkpoint);
		assert.equal(merged.length, 1);
		assert.equal(merged[0]!.id, 'ten-virtual-1');

		const decision = decideResourceMapping({
			roomId: 'room-a',
			eventDate: '2024-02-01',
			resourceKind: 'invoice',
			tenancyCandidates: merged
		});
		assert.equal(decision.action, 'map');
	});

	it('dry-run parity: second pass over same virtual keys is idempotent', () => {
		const checkpoint = sampleCheckpoint({ dryRun: true });
		const virtual = ensureDryRunVirtual(checkpoint);
		const key = 'landlord-a:legacy-1';
		virtual.managedTenantByLegacyKey[key] = 'mt-1';
		virtual.managedTenantByLegacyKey[key] = 'mt-1';
		assert.equal(Object.keys(virtual.managedTenantByLegacyKey).length, 1);
	});

	it('findVirtualActiveTenancyForRoom returns planned ACTIVE tenancy in dry-run', () => {
		const checkpoint = sampleCheckpoint({ dryRun: true, runId: 'dry-run' });
		const virtual = ensureDryRunVirtual(checkpoint);
		virtual.tenancies.push({
			id: 'ten-contract-active',
			managedTenantId: 'mt-1',
			roomId: 'room-a',
			startDate: '2024-01-01',
			endDate: null,
			status: 'ACTIVE',
			backfillSource: buildBackfillSource('dry-run', 'CONTRACT')
		});
		assert.equal(findVirtualActiveTenancyForRoom(checkpoint, 'room-a')?.id, 'ten-contract-active');
		assert.equal(findVirtualActiveTenancyForRoom(checkpoint, 'room-b'), null);
	});

	it('runCurrentRoomTenancyBatch dry-run skips when virtual ACTIVE tenancy already planned', async () => {
		const checkpoint = sampleCheckpoint({
			dryRun: true,
			runId: 'dry-run',
			cursor: { phase: 'tenancies_current_room', lastId: null }
		});
		const virtual = ensureDryRunVirtual(checkpoint);
		virtual.managedTenantByLegacyKey['landlord-a:legacy-1'] = 'mt-1';
		virtual.tenancies.push({
			id: 'ten-contract-active',
			managedTenantId: 'mt-1',
			roomId: 'room-a',
			startDate: '2024-01-01',
			endDate: null,
			status: 'ACTIVE',
			backfillSource: buildBackfillSource('dry-run', 'CONTRACT')
		});

		const currentRoomRow = {
			roomId: 'room-a',
			propertyId: 'prop-a',
			landlordId: 'landlord-a',
			tenantId: 'legacy-1',
			moveInDate: '2024-06-01'
		};
		const mockDb = {
			select: () => ({
				from: () => ({
					innerJoin: () => ({
						innerJoin: () => ({
							where: () => ({
								orderBy: () => Promise.resolve([currentRoomRow])
							})
						})
					})
				})
			})
		} as unknown as TenancyMigrationDb;

		const opts = parseBackfillCliArgs([
			'--landlord-id',
			'landlord-a',
			'--limit',
			'10',
			'--batch-size',
			'10'
		]);
		const beforeCount = virtual.tenancies.length;
		const result = await runCurrentRoomTenancyBatch(mockDb, checkpoint, opts);

		assert.equal(result.delta.scanned, 1);
		assert.equal(result.delta.skipped, 1);
		assert.equal(result.delta.tenanciesMapped, 0);
		assert.equal(virtual.tenancies.length, beforeCount);
		assert.deepEqual(checkpoint.created.tenancyIds, ['ten-contract-active']);
	});

	it('canRollbackResourceMapping only when current values match written mapping', () => {
		const mapping = {
			table: 'Invoice' as const,
			id: 'inv-1',
			managedTenantId: 'mt-1',
			tenancyId: 'ten-1',
			previousManagedTenantId: null,
			previousTenancyId: null
		};
		assert.equal(
			canRollbackResourceMapping(mapping, { managedTenantId: 'mt-1', tenancyId: 'ten-1' }),
			true
		);
		assert.equal(
			canRollbackResourceMapping(mapping, { managedTenantId: 'mt-manual', tenancyId: 'ten-1' }),
			false
		);
	});

	it('canRollbackRoomCompatibility blocks rollback after manual room cache edit', () => {
		const snapshot = {
			roomId: 'room-a',
			previousCurrentManagedTenantId: null,
			writtenCurrentManagedTenantId: 'mt-1'
		};
		assert.equal(canRollbackRoomCompatibility(snapshot, 'mt-1'), true);
		assert.equal(canRollbackRoomCompatibility(snapshot, 'mt-manual'), false);
	});

	it('buildInputScope mirrors CLI options', () => {
		const opts = parseBackfillCliArgs(['--landlord-id', 'x', '--limit', '25', '--batch-size', '5']);
		assert.deepEqual(buildInputScope(opts), {
			landlordId: 'x',
			limit: 25,
			batchSize: 5
		});
	});

	it('expectedReconcileFindingCodes covers scope, orphan, overlap, and date-range per resource', () => {
		const codes = expectedReconcileFindingCodes();
		assert.ok(codes.includes('DUPLICATE_ACTIVE_TENANCY_PER_ROOM'));
		assert.ok(codes.includes('OVERLAPPING_CONTRACT_WINDOWS'));
		for (const prefix of ['INVOICE', 'CONTRACT', 'METER_READING']) {
			assert.ok(codes.some((c) => c.startsWith('UNSCOPED_') && c.includes(prefix.split('_')[0]!)));
			assert.ok(codes.some((c) => c.startsWith('PARTIAL_SCOPE_')));
			assert.ok(codes.some((c) => c.startsWith('ORPHAN_SCOPE_')));
			assert.ok(
				codes.some((c) => c.endsWith('_OUTSIDE_TENANCY_RANGE') && c.includes(prefix.split('_')[0]!))
			);
		}
		assert.ok(codes.includes('UNSCOPED_MAINTENANCE_REQUESTS'));
		assert.ok(codes.includes('PARTIAL_SCOPE_MAINTENANCE_REQUEST'));
		assert.ok(codes.includes('ORPHAN_SCOPE_MAINTENANCE_REQUEST'));
		assert.equal(codes.length, 17);
	});

	it('belongsToBackfillRun identifies rows from the same run for crash-resume idempotency', () => {
		const runId = 'crash-run';
		const source = buildBackfillSource(runId, 'LEGACY_TENANT_PROFILE');
		assert.equal(belongsToBackfillRun(source, runId), true);
		assert.equal(belongsToBackfillRun(source, 'other-run'), false);
		assert.equal(belongsToBackfillRun(null, runId), false);
	});
});

describe('AUTH-007 checkpoint persistence', () => {
	let tempRoot = '';

	after(async () => {
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	async function tempCheckpointDir(): Promise<string> {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auth007-checkpoint-'));
		return path.join(tempRoot, 'checkpoints');
	}

	it('saveCheckpoint writes atomically with tight directory and file permissions', async () => {
		const dir = await tempCheckpointDir();
		const opts = parseBackfillCliArgs(['--landlord-id', 'landlord-a', '--limit', '10']);
		const checkpoint = newCheckpoint(opts, 'perm-run');
		checkpoint.stats.scanned = 3;

		await saveCheckpoint(dir, checkpoint);

		const filePath = checkpointPath(dir, 'perm-run');
		const dirStat = await fs.stat(dir);
		const fileStat = await fs.stat(filePath);
		assert.equal(dirStat.mode & 0o777, 0o700);
		assert.equal(fileStat.mode & 0o777, 0o600);

		const dirEntries = await fs.readdir(dir);
		assert.equal(dirEntries.length, 1);
		assert.equal(dirEntries[0], 'tenancy-backfill-perm-run.json');
		assert.equal(
			dirEntries.some((name) => name.includes('.tmp')),
			false
		);
	});

	it('crash/resume reloads checkpoint and accepts matching resume context', async () => {
		const dir = await tempCheckpointDir();
		const opts = parseBackfillCliArgs([
			'--landlord-id',
			'landlord-a',
			'--limit',
			'100',
			'--batch-size',
			'10'
		]);
		const checkpoint = newCheckpoint(opts, 'resume-run');
		checkpoint.cursor = { phase: 'tenancies_contract', lastId: 'contract-42' };
		checkpoint.stats = mergeReport(checkpoint.stats, { scanned: 5, managedTenantsCreated: 2 });
		checkpoint.created.managedTenantIds.push('mt-1', 'mt-2');

		await saveCheckpoint(dir, checkpoint);
		const reloaded = await loadCheckpoint(dir, 'resume-run');
		assert.ok(reloaded);
		assert.deepEqual(reloaded!.cursor, checkpoint.cursor);
		assert.deepEqual(reloaded!.stats, checkpoint.stats);
		assert.deepEqual(reloaded!.created.managedTenantIds, ['mt-1', 'mt-2']);

		const resumeOpts = parseBackfillCliArgs([
			'--resume',
			'resume-run',
			'--landlord-id',
			'landlord-a',
			'--limit',
			'100',
			'--batch-size',
			'10'
		]);
		assert.doesNotThrow(() => validateCheckpointResumeContext(reloaded!, resumeOpts));
	});

	it('resume twice from the same checkpoint is idempotent', async () => {
		const dir = await tempCheckpointDir();
		const opts = parseBackfillCliArgs(['--landlord-id', 'landlord-a', '--limit', '50']);
		const checkpoint = newCheckpoint(opts, 'twice-run');
		checkpoint.created.tenancyIds.push('ten-1');

		await saveCheckpoint(dir, checkpoint);
		const first = await loadCheckpoint(dir, 'twice-run');
		await saveCheckpoint(dir, first!);
		const second = await loadCheckpoint(dir, 'twice-run');
		assert.deepEqual(second, first);
	});

	it('validateCheckpointResumeContext rejects dry-run checkpoint resumed in commit mode', () => {
		const checkpoint = sampleCheckpoint({ dryRun: true });
		const commitResume = parseBackfillCliArgs([
			'--resume',
			'run-1',
			'--commit',
			'--landlord-id',
			'landlord-a',
			'--limit',
			'100',
			'--batch-size',
			'10'
		]);
		assert.throws(
			() => validateCheckpointResumeContext(checkpoint, commitResume),
			/Checkpoint mode mismatch/
		);
	});
});

describe('AUTH-007 dry-run parity and rollback safety', () => {
	it('dry-run virtual plan matches resource mapping decisions in later phases', () => {
		const checkpoint = sampleCheckpoint({ dryRun: true, runId: 'parity-run' });
		const virtual = ensureDryRunVirtual(checkpoint);
		virtual.managedTenantByLegacyKey['landlord-a:legacy-1'] = 'mt-1';
		virtual.tenancies.push(
			{
				id: 'ten-contract',
				managedTenantId: 'mt-1',
				roomId: 'room-a',
				startDate: '2024-01-01',
				endDate: '2024-12-31',
				status: 'ENDED',
				backfillSource: buildBackfillSource('parity-run', 'CONTRACT')
			},
			{
				id: 'ten-room',
				managedTenantId: 'mt-1',
				roomId: 'room-b',
				startDate: '2024-06-01',
				endDate: null,
				status: 'ACTIVE',
				backfillSource: buildBackfillSource('parity-run', 'CURRENT_ROOM')
			}
		);

		const candidates = resolveTenancyCandidates([], checkpoint);
		assert.equal(candidates.length, 2);

		const invoiceDecision = decideResourceMapping({
			roomId: 'room-a',
			eventDate: '2024-03-01',
			resourceKind: 'invoice',
			tenancyCandidates: candidates
		});
		assert.deepEqual(invoiceDecision, {
			action: 'map',
			tenancyId: 'ten-contract',
			managedTenantId: 'mt-1'
		});

		const roomOnlyInvoice = decideResourceMapping({
			roomId: 'room-b',
			eventDate: '2024-07-01',
			resourceKind: 'invoice',
			tenancyCandidates: candidates
		});
		assert.equal(roomOnlyInvoice.action, 'unresolved');
	});

	it('rollback dry-run skips writes and manual edits block rollback eligibility', async () => {
		const mapping = {
			table: 'Invoice' as const,
			id: 'inv-1',
			managedTenantId: 'mt-1',
			tenancyId: 'ten-1',
			previousManagedTenantId: null,
			previousTenancyId: null
		};
		const checkpoint = sampleCheckpoint({
			dryRun: false,
			created: {
				managedTenantIds: [],
				tenancyIds: [],
				resourceMappings: [mapping],
				roomCompatibilitySnapshots: [
					{
						roomId: 'room-a',
						previousCurrentManagedTenantId: null,
						writtenCurrentManagedTenantId: 'mt-1'
					}
				]
			}
		});

		const dryReport = await rollbackBackfillRun(null as never, checkpoint, false);
		assert.equal(dryReport.scanned, 2);
		assert.equal(dryReport.skipped, 2);
		assert.equal(dryReport.errors, 0);

		assert.equal(
			canRollbackResourceMapping(mapping, { managedTenantId: 'mt-edited', tenancyId: 'ten-1' }),
			false
		);
		assert.equal(
			canRollbackRoomCompatibility(checkpoint.created.roomCompatibilitySnapshots[0]!, 'mt-edited'),
			false
		);
	});
});
