#!/usr/bin/env tsx
/**
 * AUTH-007 — backfill ManagedTenant/Tenancy and map historical resources.
 * Defaults to dry-run. Commit requires --commit plus BACKFILL_TENANCY_ENV_ALLOWLIST.
 */
import {
	parseBackfillCliArgs,
	createScriptDb,
	runBackfillTenancies
} from './tenancy-migration-lib.js';

async function main() {
	const opts = parseBackfillCliArgs(process.argv.slice(2));
	const { db, close } = createScriptDb();
	try {
		const { runId, report } = await runBackfillTenancies(db, opts);
		console.log(
			JSON.stringify(
				{
					mode: opts.rollbackRunId ? 'rollback' : 'backfill',
					dryRun: !opts.commit,
					runId,
					landlordId: opts.landlordId ?? null,
					report
				},
				null,
				2
			)
		);
	} finally {
		await close();
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
