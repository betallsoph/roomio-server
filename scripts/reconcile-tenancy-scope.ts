#!/usr/bin/env tsx
/**
 * AUTH-007 — reconciliation queries for tenancy scope consistency.
 */
import {
	assertBackfillEnvironmentAllowed,
	createScriptDb,
	runTenancyReconciliation
} from './tenancy-migration-lib.js';

function parseArgs(argv: string[]): { landlordId?: string } {
	const opts: { landlordId?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--landlord-id') {
			opts.landlordId = argv[++i];
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return opts;
}

async function main() {
	assertBackfillEnvironmentAllowed(false);
	const opts = parseArgs(process.argv.slice(2));
	const { db, close } = createScriptDb();
	try {
		const findings = await runTenancyReconciliation(db, opts.landlordId);
		console.log(
			JSON.stringify({ mode: 'reconcile', landlordId: opts.landlordId ?? null, findings }, null, 2)
		);
	} finally {
		await close();
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
