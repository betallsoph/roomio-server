import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	assertBackfillEnvironmentAllowed,
	backfillManagedTenantClaimFields,
	buildBackfillSource,
	contactFingerprint,
	datesOverlap,
	decideResourceMapping,
	detectOverlappingContracts,
	findTenancyForDate,
	mergeReport,
	parseBackfillCliArgs,
	parseBackfillSource,
	shouldReloadTenancyCandidatesAtPhaseStart,
	type TenancyCandidate
} from './tenancy-migration-lib.js';

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
});
