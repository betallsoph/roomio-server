import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
	assertHealthBodyDoesNotLeak,
	checkDatabaseReady,
	isPublicHealthPath,
	liveHealthBody,
	readyHealthBody
} from './health.js';
import { closeDbPool, resetDbPoolCloseStateForTests } from './db/shutdown.js';
import { pool } from './db/index.js';
import { handleShutdown, resetLifecycleForTests } from './lifecycle.js';
import { handle } from '../../hooks.server.js';
import { GET as liveGet } from '../../routes/api/health/live/+server.js';

const waitScript = fileURLToPath(
	new URL('../../../scripts/wait-for-readiness.sh', import.meta.url)
);

function createEvent(pathname: string, method: string) {
	return {
		url: new URL(`http://localhost${pathname}`),
		request: new Request(`http://localhost${pathname}`, { method }),
		cookies: {
			get: () => undefined,
			set: () => {},
			delete: () => {},
			serialize: () => '',
			getAll: () => []
		},
		locals: {},
		getClientAddress: () => '127.0.0.1',
		params: {},
		route: { id: pathname },
		isDataRequest: false,
		isSubRequest: false,
		platform: undefined,
		depends: () => {},
		fetch,
		setHeaders: () => {},
		parent: async () => ({})
	};
}

test('isPublicHealthPath matches only canonical live and ready routes', () => {
	assert.equal(isPublicHealthPath('/api/health/live'), true);
	assert.equal(isPublicHealthPath('/api/health/ready'), true);
	assert.equal(isPublicHealthPath('/api/health'), false);
	assert.equal(isPublicHealthPath('/api/health/live/extra'), false);
});

test('liveHealthBody returns canonical ok payload', () => {
	assert.deepEqual(liveHealthBody(), { status: 'ok' });
});

test('readyHealthBody returns safe payloads without internal details', () => {
	assert.deepEqual(readyHealthBody(true), { status: 'ok' });
	assert.deepEqual(readyHealthBody(false), { status: 'unavailable' });
	assertHealthBodyDoesNotLeak(JSON.stringify(readyHealthBody(false)));
});

test('checkDatabaseReady returns true when SELECT 1 succeeds', async () => {
	const ready = await checkDatabaseReady({
		query: (async () => ({ rows: [{ '?column?': 1 }], rowCount: 1, command: 'SELECT' })) as never
	});
	assert.equal(ready, true);
});

test('checkDatabaseReady returns false when query fails', async () => {
	const ready = await checkDatabaseReady({
		query: async () => {
			throw new Error('connection refused to postgres://secret@db.internal:5432/roomio');
		}
	});
	assert.equal(ready, false);
});

test('checkDatabaseReady returns false on timeout', async () => {
	const ready = await checkDatabaseReady(
		{
			query: (() => new Promise(() => {})) as never
		},
		20
	);
	assert.equal(ready, false);
});

test('GET /api/health/live handler returns 200 without database access', async () => {
	const response = await liveGet(createEvent('/api/health/live', 'GET') as never);
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body, { status: 'ok' });
	assertHealthBodyDoesNotLeak(JSON.stringify(body));
});

test('DB down: ready body is 503-safe and does not leak internals', async () => {
	const ready = await checkDatabaseReady({
		query: async () => {
			throw new Error('ECONNREFUSED at hostname db.internal');
		}
	});
	const body = readyHealthBody(ready);
	const payload = JSON.stringify(body);
	assert.equal(ready, false);
	assert.deepEqual(body, { status: 'unavailable' });
	assert.equal(payload.includes('ECONN'), false);
	assert.equal(payload.includes('hostname'), false);
	assert.equal(payload.includes('stack'), false);
});

test('health GET routes are public without session', async () => {
	for (const pathname of ['/api/health/live', '/api/health/ready']) {
		const response = await handle({
			event: createEvent(pathname, 'GET') as never,
			resolve: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
		});
		assert.equal(response.status, 200, pathname);
	}
});

test('POST health routes are rejected with 405', async () => {
	for (const pathname of ['/api/health/live', '/api/health/ready']) {
		const response = await handle({
			event: createEvent(pathname, 'POST') as never,
			resolve: async () => new Response('unexpected', { status: 500 })
		});
		assert.equal(response.status, 405, pathname);
		const body = await response.json();
		assert.equal(JSON.stringify(body).includes('stack'), false);
	}
});

test('closeDbPool ends the pool only once', async () => {
	resetDbPoolCloseStateForTests();
	const originalEnd = pool.end.bind(pool);
	let endCalls = 0;
	pool.end = (async () => {
		endCalls += 1;
	}) as typeof pool.end;

	try {
		await closeDbPool();
		await closeDbPool();
		assert.equal(endCalls, 1);
	} finally {
		pool.end = originalEnd;
		resetDbPoolCloseStateForTests();
	}
});

test('handleShutdown closes database pool on sveltekit shutdown', async () => {
	resetDbPoolCloseStateForTests();
	const originalEnd = pool.end.bind(pool);
	let ended = false;
	pool.end = (async () => {
		ended = true;
	}) as typeof pool.end;

	try {
		await handleShutdown('SIGTERM');
		assert.equal(ended, true);
	} finally {
		pool.end = originalEnd;
		resetDbPoolCloseStateForTests();
		resetLifecycleForTests();
	}
});

test('wait-for-readiness.sh exits non-zero when probe never succeeds', () => {
	const result = spawnSync('sh', [waitScript, 'http://127.0.0.1:1/not-ready', '1', '1'], {
		encoding: 'utf8'
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr ?? '', /readiness check failed/i);
});

test('wait-for-readiness.sh exits zero when probe succeeds', async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok' }));
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const { port } = server.address() as AddressInfo;

	try {
		const child = spawn('sh', [waitScript, `http://127.0.0.1:${port}/api/health/ready`, '3', '1']);
		const [code] = await once(child, 'close');
		assert.equal(code, 0);
	} finally {
		server.close();
	}
});
