import assert from 'node:assert/strict';
import test from 'node:test';

// INFRA-005 — test cấu hình pool bằng unit test/mock; không mở PostgreSQL thật.

const {
	buildApplicationName,
	buildPoolConfig,
	collectPoolMetrics,
	isPoolConnectionTimeout,
	poolMaxForRole,
	scrubPoolError,
	startPoolMetrics,
	totalConfiguredConnections,
	POOL_METRICS_INTERVAL_MS
} = await import('./pool.js');

const { parseEnv, EnvValidationError, DB_POOL_TOTAL_BUDGET, MAX_DB_STATEMENT_TIMEOUT_MS } =
	await import('../env.js');

/** Env tối thiểu hợp lệ cho môi trường không phải production. */
function baseEnvSource(over: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		NODE_ENV: 'development',
		DATABASE_URL: 'postgres://roomio:local-dev-only-password@localhost:5432/roomio',
		...over
	} as NodeJS.ProcessEnv;
}

function envWith(over: Record<string, string> = {}) {
	return parseEnv(baseEnvSource(over));
}

function expectEnvErrors(over: Record<string, string>): string[] {
	try {
		parseEnv(baseEnvSource(over));
		assert.fail('parseEnv should have rejected this configuration');
	} catch (error) {
		assert.ok(error instanceof EnvValidationError, 'expected EnvValidationError');
		return (error as InstanceType<typeof EnvValidationError>).variableNames;
	}
}

// --- Giá trị mặc định theo spec A1 ---------------------------------------------

test('defaults match the A1 one-OCPU budget from INFRA-005', () => {
	const env = envWith();
	assert.equal(env.db.apiPoolMax, 6);
	assert.equal(env.db.dispatcherPoolMax, 2);
	assert.equal(env.db.connectionTimeoutMs, 3000);
	assert.equal(env.db.idleTimeoutMs, 30000);
	assert.equal(env.db.statementTimeoutMs, 15000);
	assert.equal(env.db.lockTimeoutMs, 3000);
	assert.equal(env.db.idleInTransactionTimeoutMs, 10000);
});

test('default API + dispatcher total is exactly the 8 connection budget', () => {
	const env = envWith();
	assert.equal(totalConfiguredConnections(env.db), 8);
	assert.equal(totalConfiguredConnections(env.db) <= DB_POOL_TOTAL_BUDGET, true);
});

test('poolMaxForRole picks the max belonging to each process role', () => {
	const env = envWith();
	assert.equal(poolMaxForRole(env.db, 'api'), 6);
	assert.equal(poolMaxForRole(env.db, 'dispatcher'), 2);
});

// --- Ngân sách tổng -------------------------------------------------------------

test('rejects a combined pool budget above 8 connections', () => {
	const names = expectEnvErrors({ API_DB_POOL_MAX: '7', DISPATCHER_DB_POOL_MAX: '2' });
	assert.ok(names.includes('API_DB_POOL_MAX'));
	assert.ok(names.includes('DISPATCHER_DB_POOL_MAX'));
});

test('accepts a rebalanced budget that still totals 8 or less', () => {
	const env = envWith({ API_DB_POOL_MAX: '5', DISPATCHER_DB_POOL_MAX: '3' });
	assert.equal(totalConfiguredConnections(env.db), 8);
	const smaller = envWith({ API_DB_POOL_MAX: '4', DISPATCHER_DB_POOL_MAX: '2' });
	assert.equal(totalConfiguredConnections(smaller.db), 6);
});

test('a single oversized pool is rejected even before the sum is checked', () => {
	assert.ok(expectEnvErrors({ API_DB_POOL_MAX: '20' }).includes('API_DB_POOL_MAX'));
});

// --- Giá trị sai định dạng phải chặn boot, không im lặng fallback ---------------

test('non-numeric, zero, negative and fractional pool values are rejected by name', () => {
	assert.ok(expectEnvErrors({ API_DB_POOL_MAX: 'six' }).includes('API_DB_POOL_MAX'));
	assert.ok(expectEnvErrors({ API_DB_POOL_MAX: '0' }).includes('API_DB_POOL_MAX'));
	assert.ok(expectEnvErrors({ DB_IDLE_TIMEOUT_MS: '-1' }).includes('DB_IDLE_TIMEOUT_MS'));
	assert.ok(
		expectEnvErrors({ DB_CONNECTION_TIMEOUT_MS: '1.5' }).includes('DB_CONNECTION_TIMEOUT_MS')
	);
});

test('empty value falls back to the documented default instead of failing', () => {
	const env = envWith({ API_DB_POOL_MAX: '' });
	assert.equal(env.db.apiPoolMax, 6);
});

// --- Không nới timeout để che query chậm ---------------------------------------

test('statement timeout above the hard ceiling is rejected', () => {
	const names = expectEnvErrors({
		DB_STATEMENT_TIMEOUT_MS: String(MAX_DB_STATEMENT_TIMEOUT_MS + 1)
	});
	assert.ok(names.includes('DB_STATEMENT_TIMEOUT_MS'));
});

test('lock timeout above the hard ceiling is rejected', () => {
	assert.ok(expectEnvErrors({ DB_LOCK_TIMEOUT_MS: '60000' }).includes('DB_LOCK_TIMEOUT_MS'));
});

test('a lower statement timeout is always allowed', () => {
	assert.equal(envWith({ DB_STATEMENT_TIMEOUT_MS: '5000' }).db.statementTimeoutMs, 5000);
});

// --- PoolConfig truyền xuống pg -------------------------------------------------

test('buildPoolConfig maps every timeout onto the driver fields pg transmits', () => {
	const config = buildPoolConfig(envWith(), 'api');
	assert.equal(config.max, 6);
	assert.equal(config.connectionTimeoutMillis, 3000);
	assert.equal(config.idleTimeoutMillis, 30000);
	assert.equal(config.statement_timeout, 15000);
	assert.equal(config.lock_timeout, 3000);
	assert.equal(config.idle_in_transaction_session_timeout, 10000);
	assert.equal(config.connectionString, envWith().databaseUrl);
});

test('dispatcher role gets its own smaller max but the same timeouts', () => {
	const env = envWith();
	const api = buildPoolConfig(env, 'api');
	const dispatcher = buildPoolConfig(env, 'dispatcher');
	assert.equal(dispatcher.max, 2);
	assert.equal(api.max, 6);
	assert.equal(dispatcher.statement_timeout, api.statement_timeout);
	assert.equal(dispatcher.connectionTimeoutMillis, api.connectionTimeoutMillis);
	assert.equal((api.max ?? 0) + (dispatcher.max ?? 0) <= DB_POOL_TOTAL_BUDGET, true);
});

test('connection timeout is always finite so readiness cannot queue forever', () => {
	const config = buildPoolConfig(envWith(), 'api');
	assert.equal(Number.isFinite(config.connectionTimeoutMillis), true);
	assert.ok((config.connectionTimeoutMillis ?? 0) > 0);
});

// --- application_name -----------------------------------------------------------

test('application_name carries process role and short release sha', () => {
	assert.equal(buildApplicationName('api', 'abcdef1234567890'), 'roomio-api:abcdef1');
	assert.equal(buildApplicationName('dispatcher', 'abcdef1234567890'), 'roomio-dispatcher:abcdef1');
});

test('application_name degrades safely when release sha is unknown or empty', () => {
	assert.equal(buildApplicationName('api', ''), 'roomio-api:unknown');
	assert.equal(buildApplicationName('api', 'unknown'), 'roomio-api:unknown');
});

test('application_name stays inside the 63 byte Postgres limit', () => {
	const name = buildApplicationName('dispatcher', 'f'.repeat(400));
	assert.ok(name.length <= 63, `application_name too long: ${name.length}`);
});

test('buildPoolConfig puts application_name onto the pool config', () => {
	const env = envWith({ RELEASE_SHA: '1234567890abcdef' });
	assert.equal(buildPoolConfig(env, 'api').application_name, 'roomio-api:1234567');
});

// --- Lỗi pool được scrub --------------------------------------------------------

test('scrubPoolError keeps only safe fields', () => {
	const error = Object.assign(
		new Error('connection to server at "10.0.0.5", port 5432 failed: password authentication'),
		{ code: '28P01' }
	);
	const scrubbed = scrubPoolError(error, 'api');
	assert.deepEqual(scrubbed, {
		event: 'db_pool_error',
		role: 'api',
		code: '28P01',
		errorName: 'Error'
	});
});

test('scrubbed pool error never carries host, password or message text', () => {
	const error = Object.assign(new Error('host=db.internal password=hunter2 user=roomio'), {
		code: '57P01'
	});
	const serialized = JSON.stringify(scrubPoolError(error, 'dispatcher'));
	for (const leak of ['db.internal', 'hunter2', 'roomio', 'password', 'host=']) {
		assert.equal(serialized.includes(leak), false, `leaked ${leak}`);
	}
});

test('scrubPoolError handles non-Error values without throwing', () => {
	assert.deepEqual(scrubPoolError('boom', 'api'), {
		event: 'db_pool_error',
		role: 'api',
		code: 'UNKNOWN',
		errorName: 'UnknownError'
	});
	assert.equal(scrubPoolError(null, 'api').code, 'UNKNOWN');
});

// --- Phân biệt pool timeout với lỗi nghiệp vụ ----------------------------------

test('isPoolConnectionTimeout only matches pool exhaustion', () => {
	assert.equal(isPoolConnectionTimeout(new Error('timeout exceeded when trying to connect')), true);
	assert.equal(isPoolConnectionTimeout(new Error('duplicate key value violates unique')), false);
	assert.equal(isPoolConnectionTimeout('timeout exceeded when trying to connect'), false);
	assert.equal(isPoolConnectionTimeout(undefined), false);
});

// --- Metric -----------------------------------------------------------------------

test('collectPoolMetrics reports total, idle and waiting counts', () => {
	const fakePool = { totalCount: 6, idleCount: 1, waitingCount: 4 };
	assert.deepEqual(collectPoolMetrics(fakePool, 'api', 6), {
		event: 'db_pool_metrics',
		role: 'api',
		totalCount: 6,
		idleCount: 1,
		waitingCount: 4,
		max: 6
	});
});

test('metrics sampler emits on its interval and stops cleanly', async () => {
	const fakePool = { totalCount: 2, idleCount: 2, waitingCount: 0 };
	const seen: unknown[] = [];
	const stop = startPoolMetrics(fakePool, 'api', {
		intervalMs: 5,
		max: 6,
		sink: (m) => seen.push(m)
	});
	await new Promise((resolve) => setTimeout(resolve, 40));
	stop();
	const countAtStop = seen.length;
	assert.ok(countAtStop >= 1, 'sampler should have emitted at least once');
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(seen.length, countAtStop, 'sampler must not emit after stop');
});

test('metrics timer is unref-ed so it cannot keep the process alive', () => {
	let unrefCalled = false;
	const realSetInterval = globalThis.setInterval;
	// @ts-expect-error — thay tạm để quan sát unref
	globalThis.setInterval = (...args: Parameters<typeof setInterval>) => {
		const timer = realSetInterval(...args);
		const realUnref = timer.unref.bind(timer);
		timer.unref = () => {
			unrefCalled = true;
			return realUnref();
		};
		return timer;
	};
	try {
		const stop = startPoolMetrics({ totalCount: 0, idleCount: 0, waitingCount: 0 }, 'api', {
			intervalMs: 60_000,
			max: 6,
			sink: () => {}
		});
		stop();
	} finally {
		globalThis.setInterval = realSetInterval;
	}
	assert.equal(unrefCalled, true, 'startPoolMetrics must unref its timer');
});

test('default metrics interval stays within the 15-30s sampling window', () => {
	assert.ok(POOL_METRICS_INTERVAL_MS >= 15_000);
	assert.ok(POOL_METRICS_INTERVAL_MS <= 30_000);
});
