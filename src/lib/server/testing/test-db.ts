import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';

const MIGRATIONS_FOLDER = path.resolve(
	fileURLToPath(new URL('../../../../drizzle', import.meta.url))
);

const DRIZZLE_MIGRATIONS_TABLE = '__drizzle_migrations';

export class SecurityIntegrationDisabledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SecurityIntegrationDisabledError';
	}
}

/** True when DATABASE_URL is postgres and SECURITY_INTEGRATION=1 on a disposable test DB. */
export function isSecurityIntegrationEnabled(): boolean {
	return getSecurityIntegrationSkipReason() === undefined;
}

/** Human-readable skip reason for node:test `skip` option; undefined when integration may run. */
export function getSecurityIntegrationSkipReason(): string | undefined {
	const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
	if (!databaseUrl.startsWith('postgres')) {
		return 'SECURITY_INTEGRATION_SKIP: set DATABASE_URL to a postgres:// test database';
	}
	if (process.env.SECURITY_INTEGRATION !== '1') {
		return 'SECURITY_INTEGRATION_SKIP: set SECURITY_INTEGRATION=1 to run Postgres security integration tests';
	}
	if (!isDisposableTestDatabase(databaseUrl)) {
		return 'SECURITY_INTEGRATION_SKIP: DATABASE_URL database name must contain test, disposable, or security';
	}
	return undefined;
}

export function assertSecurityIntegrationEnabled(): void {
	const reason = getSecurityIntegrationSkipReason();
	if (reason) {
		throw new SecurityIntegrationDisabledError(reason);
	}
}

/** Short unique suffix for fixture IDs so a suite can run twice without unique-key collisions. */
export function createSecurityRunId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `sec_${ts}_${rand}`;
}

export type SecurityDbHandle = {
	db: NodePgDatabase<typeof schema>;
	pool: Pool;
	/** Per-invocation run id — use in fixture emails/phones when reusing static prefixes. */
	runId: string;
};

let sharedPool: Pool | undefined;
let migrationsReady = false;

function isDisposableTestDatabase(raw: string): boolean {
	try {
		const dbName = new URL(raw).pathname.replace(/^\//, '');
		return /test|disposable|security/i.test(dbName);
	} catch {
		return false;
	}
}

function requireDatabaseUrl(): string {
	assertSecurityIntegrationEnabled();
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new SecurityIntegrationDisabledError(
			'SECURITY_INTEGRATION_SKIP: DATABASE_URL is required for security integration tests'
		);
	}
	return databaseUrl;
}

function getOrCreatePool(): Pool {
	const databaseUrl = requireDatabaseUrl();
	if (!sharedPool) {
		sharedPool = new Pool({ connectionString: databaseUrl, max: 4 });
	}
	return sharedPool;
}

async function ensureMigrations(pool: Pool): Promise<void> {
	if (migrationsReady) return;
	const migrationDb = drizzle(pool);
	await migrate(migrationDb, { migrationsFolder: MIGRATIONS_FOLDER });
	migrationsReady = true;
}

/**
 * Truncate every application table in public schema (keeps drizzle migration history).
 * Safe to call between suites — allows reusing fixed fixture IDs on the next run.
 */
export async function resetSecurityDb(pool: Pool = getOrCreatePool()): Promise<void> {
	requireDatabaseUrl();
	const client = await pool.connect();
	try {
		const tables = await client.query<{ table_name: string }>(
			`SELECT table_name
			 FROM information_schema.tables
			 WHERE table_schema = 'public'
			   AND table_type = 'BASE TABLE'
			   AND table_name <> $1
			 ORDER BY table_name`,
			[DRIZZLE_MIGRATIONS_TABLE]
		);
		if (tables.rows.length === 0) return;

		const quoted = tables.rows.map((row) => `"${row.table_name.replace(/"/g, '""')}"`).join(', ');
		await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
	} finally {
		client.release();
	}
}

/**
 * Run a security integration callback against an isolated, migrated Postgres database.
 * Resets data before and after fn; does not start local Postgres or Testcontainers.
 */
export async function withSecurityDb<T>(fn: (handle: SecurityDbHandle) => Promise<T>): Promise<T> {
	const pool = getOrCreatePool();
	await ensureMigrations(pool);
	await resetSecurityDb(pool);

	const db = drizzle(pool, { schema });
	const runId = createSecurityRunId();
	const handle: SecurityDbHandle = { db, pool, runId };

	try {
		return await fn(handle);
	} finally {
		await resetSecurityDb(pool);
	}
}

/** Close the shared pool — call from suite teardown when the process exits integration mode. */
export async function closeSecurityDbPool(): Promise<void> {
	if (!sharedPool) return;
	await sharedPool.end();
	sharedPool = undefined;
	migrationsReady = false;
}

/** Verify connectivity without mutating data (for harness diagnostics). */
export async function pingSecurityDb(): Promise<boolean> {
	if (!isSecurityIntegrationEnabled()) return false;
	const pool = getOrCreatePool();
	const db = drizzle(pool);
	await db.execute(sql`SELECT 1`);
	return true;
}
