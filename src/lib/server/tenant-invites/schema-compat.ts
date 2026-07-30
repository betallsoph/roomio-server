/**
 * AUTH-009 — detect whether migration 0026 canonical invite columns are applied.
 * Phase 1 code paths probe this instead of creating invite-anchor rows.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '$lib/server/db/schema';

type SchemaProbeDb = NodePgDatabase<typeof schema>;

let cachedCanonicalInviteSchema: boolean | null = null;

export async function schemaSupportsCanonicalTenantInvites(conn: SchemaProbeDb): Promise<boolean> {
	if (cachedCanonicalInviteSchema !== null) return cachedCanonicalInviteSchema;

	const result = await conn.execute<{
		tenant_nullable: string | null;
		token_nullable: string | null;
	}>(sql`
		SELECT
			MAX(CASE WHEN column_name = 'tenantId' THEN is_nullable END) AS tenant_nullable,
			MAX(CASE WHEN column_name = 'token' THEN is_nullable END) AS token_nullable
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'TenantInvite'
			AND column_name IN ('tenantId', 'token')
	`);

	const row = result.rows[0];
	cachedCanonicalInviteSchema = row?.tenant_nullable === 'YES' && row?.token_nullable === 'YES';
	return cachedCanonicalInviteSchema;
}

/** Test-only: reset probe cache between integration runs. */
export function resetCanonicalInviteSchemaCacheForTests(): void {
	cachedCanonicalInviteSchema = null;
}
