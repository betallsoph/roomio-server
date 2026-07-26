import type { Pool } from 'pg';
import { pool } from '$lib/server/db';

/** Shorter than typical Nginx proxy timeouts so probes do not hang. */
export const READINESS_TIMEOUT_MS = 2_000;

export const PUBLIC_HEALTH_GET_PATHS = new Set(['/api/health/live', '/api/health/ready']);

const SENSITIVE_BODY_PATTERNS = [
	/at\s+/i,
	/node_modules/i,
	/postgres/i,
	/password/i,
	/hostname/i,
	/process\.env/i,
	/stack/i,
	/EADDR/i,
	/ECONN/i
];

export function isPublicHealthPath(pathname: string): boolean {
	return PUBLIC_HEALTH_GET_PATHS.has(pathname);
}

export function liveHealthBody(): { status: 'ok' } {
	return { status: 'ok' };
}

export function readyHealthBody(ready: boolean): { status: 'ok' } | { status: 'unavailable' } {
	return ready ? { status: 'ok' } : { status: 'unavailable' };
}

export function assertHealthBodyDoesNotLeak(body: string): void {
	for (const pattern of SENSITIVE_BODY_PATTERNS) {
		if (pattern.test(body)) {
			throw new Error(`Health response leaked sensitive details: ${pattern}`);
		}
	}
}

export async function checkDatabaseReady(
	queryPool: Pick<Pool, 'query'> = pool,
	timeoutMs = READINESS_TIMEOUT_MS
): Promise<boolean> {
	try {
		await Promise.race([
			queryPool.query('SELECT 1'),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('READINESS_TIMEOUT')), timeoutMs);
			})
		]);
		return true;
	} catch {
		return false;
	}
}
