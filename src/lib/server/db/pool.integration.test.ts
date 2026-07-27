import assert from 'node:assert/strict';
import test from 'node:test';

// INFRA-005 — integration test chứng minh timeout THẬT SỰ có hiệu lực trên PostgreSQL.
//
// Chạy trong GitHub Actions (job `quality` đã có postgres service) hoặc staging.
// Guard: chỉ chạy khi DATABASE_URL trỏ tới Postgres localhost có tên DB đánh dấu test.
// Ngoài ra tự skip, không bao giờ chạm database thật.
//
// Mỗi test dựng pool RIÊNG với timeout ngắn để chạy nhanh và không phụ thuộc giá trị
// mặc định production; giá trị mặc định đã được pool.test.ts phủ.

const DB_URL = process.env.DATABASE_URL ?? '';

function isDisposableTestDb(raw: string): boolean {
	try {
		const parsed = new URL(raw);
		const localish = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
		const dbName = parsed.pathname.replace(/^\//, '');
		return localish && /test|ci|disposable|infra005/i.test(dbName);
	} catch {
		return false;
	}
}

const RUN = DB_URL.startsWith('postgres') && isDisposableTestDb(DB_URL);

if (!RUN) {
	test(
		'INFRA-005 pool timeouts against real PostgreSQL',
		{
			skip: 'PENDING_INTEGRATION: needs DATABASE_URL pointing at a disposable localhost test database'
		},
		() => {}
	);
} else {
	const { Pool } = await import('pg');
	const { buildPoolConfig, collectPoolMetrics, isPoolConnectionTimeout } =
		await import('./pool.js');
	const { parseEnv } = await import('../env.js');

	/** Env thật + override để test nhanh, vẫn đi qua đúng buildPoolConfig. */
	function poolFor(over: Record<string, string> = {}) {
		const env = parseEnv({
			NODE_ENV: 'development',
			DATABASE_URL: DB_URL,
			RELEASE_SHA: 'abc1234def',
			...over
		} as NodeJS.ProcessEnv);
		return new Pool(buildPoolConfig(env, 'api'));
	}

	test('statement_timeout cancels a slow query and returns the connection to the pool', async () => {
		const pool = poolFor({ DB_STATEMENT_TIMEOUT_MS: '400', API_DB_POOL_MAX: '2' });
		try {
			await assert.rejects(
				() => pool.query('SELECT pg_sleep(3)'),
				(error: unknown) => {
					// 57014 = query_canceled: Postgres tự hủy, không phải client bỏ cuộc.
					assert.equal((error as { code?: string }).code, '57014');
					return true;
				}
			);

			// Connection phải dùng lại được ngay, không bị rò.
			const after = await pool.query('SELECT 1 AS ok');
			assert.equal(after.rows[0].ok, 1);
			assert.equal(collectPoolMetrics(pool, 'api', 2).waitingCount, 0);
		} finally {
			await pool.end();
		}
	});

	test('connection timeout bounds the queue when the pool is exhausted', async () => {
		const pool = poolFor({
			API_DB_POOL_MAX: '1',
			DISPATCHER_DB_POOL_MAX: '1',
			DB_CONNECTION_TIMEOUT_MS: '400'
		});
		try {
			// Giữ connection duy nhất để pool cạn.
			const held = await pool.connect();
			const startedAt = Date.now();

			await assert.rejects(
				() => pool.query('SELECT 1'),
				(error: unknown) => {
					assert.equal(isPoolConnectionTimeout(error), true);
					return true;
				}
			);

			// Fail nhanh theo hạn đã đặt, không treo vô hạn.
			assert.ok(Date.now() - startedAt < 5_000, 'queued query must fail fast, not hang');

			held.release();
			const after = await pool.query('SELECT 1 AS ok');
			assert.equal(after.rows[0].ok, 1);
			assert.equal(collectPoolMetrics(pool, 'api', 1).waitingCount, 0, 'waitingCount must drain');
		} finally {
			await pool.end();
		}
	});

	test('idle_in_transaction_session_timeout kills a transaction left open', async () => {
		const pool = poolFor({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '400', API_DB_POOL_MAX: '2' });
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query('SELECT 1');
			await new Promise((resolve) => setTimeout(resolve, 1_500));

			await assert.rejects(
				() => client.query('SELECT 1'),
				(error: unknown) => {
					// 25P03 = idle_in_transaction_session_timeout; driver có thể báo connection đã đóng.
					const code = (error as { code?: string }).code;
					assert.ok(
						code === '25P03' || code === undefined || code === '08006' || code === '08003',
						`unexpected error code: ${String(code)}`
					);
					return true;
				}
			);
		} finally {
			client.release();
			await pool.end();
		}
	});

	test('application_name identifies process role and release in pg_stat_activity', async () => {
		const pool = poolFor();
		try {
			const result = await pool.query(
				'SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()'
			);
			assert.equal(result.rows[0].application_name, 'roomio-api:abc1234');
		} finally {
			await pool.end();
		}
	});

	test('pool never opens more connections than its configured max', async () => {
		const pool = poolFor({ API_DB_POOL_MAX: '2' });
		try {
			await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.05)')));
			const metrics = collectPoolMetrics(pool, 'api', 2);
			assert.ok(metrics.totalCount <= 2, `totalCount ${metrics.totalCount} exceeded max 2`);
			assert.equal(metrics.waitingCount, 0);
		} finally {
			await pool.end();
		}
	});
}
