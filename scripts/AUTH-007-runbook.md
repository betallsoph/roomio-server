# AUTH-007 — Tenancy migration scripts runbook

Read-only profiler, dry-run backfill, reconciliation, and staged commit for ManagedTenant/Tenancy.

## Safety

- **Never run on production.** Scripts exit if `NODE_ENV=production`.
- Backfill **defaults to dry-run**. Writes require `--commit`.
- Commit mode additionally requires `BACKFILL_TENANCY_ENV_ALLOWLIST` to include the current `NODE_ENV` (e.g. `development,staging,test`).
- Output reports counts and technical IDs only — no contact names, phones, or file content.

## Commands

```bash
export PATH="/tmp/node24/bin:$PATH"
export DATABASE_URL="postgres://..."
export NODE_ENV=development

# Phase 0 — profile (read-only)
npm run tenancy:profile
npm run tenancy:profile -- --landlord-id <uuid>

# Phase 3 — backfill (dry-run default)
npm run tenancy:backfill -- --landlord-id <uuid> --limit 500 --batch-size 100

# Commit on allowlisted env only
export BACKFILL_TENANCY_ENV_ALLOWLIST=development,staging,test
npm run tenancy:backfill -- --commit --landlord-id <uuid> --limit 500

# Resume a run
npm run tenancy:backfill -- --resume <runId> --limit 500

# Rollback mappings from a run (dry-run first)
npm run tenancy:backfill -- --rollback <runId>
npm run tenancy:backfill -- --rollback <runId> --commit

# Phase 4 — reconcile
npm run tenancy:reconcile
npm run tenancy:reconcile -- --landlord-id <uuid>
```

Checkpoints are stored under `.checkpoints/tenancy-backfill/` by default (`--checkpoint-dir` to override).

## Report fields

`scanned`, `managedTenantsCreated`, `claimed`, `tenanciesMapped`, `unresolved`, `skipped`, `errors`.

## Rollback

Rollback uses the checkpoint file for the run. It only clears mappings and deletes ManagedTenant/Tenancy rows created by that run (`backfillSource` prefix `AUTH007:<runId>:`). Rows touched manually after backfill are not deleted.
