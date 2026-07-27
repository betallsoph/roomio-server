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
	// Hàng đợi có trần hai lớp: probe bỏ cuộc sau `timeoutMs`, và INFRA-005 đặt
	// `connectionTimeoutMillis` nên query đang chờ connection cũng tự fail — probe
	// không thể tích tụ query treo vô hạn khi pool cạn.
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			queryPool.query('SELECT 1'),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('READINESS_TIMEOUT')), timeoutMs);
			})
		]);
		return true;
	} catch {
		return false;
	} finally {
		// Không để lại timer treo sau mỗi lần probe.
		if (timer) clearTimeout(timer);
	}
}
