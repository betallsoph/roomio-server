import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import {
	createLogger,
	getLogger,
	isValidRequestId,
	logHttpRequest,
	resolveRequestId,
	resetLoggerForTests,
	setLoggerForTests,
	LOG_ROTATION_DEFAULTS,
	LOG_ROTATE_CONFIG_SNIPPET
} from './index.js';
import { handle, handleError } from '../../../hooks.server.js';

const TEST_ENV = {
	NODE_ENV: 'test',
	DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio',
	SESSION_SECRET: 'roomio-local-dev-secret-32chars-min!!',
	ORIGIN: 'http://localhost:3000',
	PUBLIC_APP_ORIGIN: 'http://localhost:5173'
};

async function withTestEnv<T>(fn: () => T | Promise<T>): Promise<T> {
	const previous = { ...process.env };
	Object.assign(process.env, TEST_ENV);
	resetLoggerForTests();
	try {
		return await fn();
	} finally {
		process.env = previous;
		resetLoggerForTests();
	}
}

function captureLogs(fn: () => void): string[] {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			lines.push(String(chunk).trim());
			callback();
		}
	});
	setLoggerForTests(createLogger(stream));
	fn();
	return lines;
}

function createEvent(pathname: string, method: string, requestId?: string, localsRequestId?: string) {
	const headers = new Headers();
	if (requestId) headers.set('x-request-id', requestId);

	return {
		url: new URL(`http://localhost${pathname}`),
		request: new Request(`http://localhost${pathname}`, { method, headers }),
		cookies: {
			get: () => undefined,
			set: () => {},
			delete: () => {},
			serialize: () => '',
			getAll: () => []
		},
		locals: {
			...(localsRequestId ? { requestId: localsRequestId } : {})
		} as App.Locals,
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

test('resolveRequestId keeps valid external IDs', async () => {
	await withTestEnv(() => {
		const external = 'corr-id-12345678';
		assert.equal(resolveRequestId(external), external);
		assert.equal(isValidRequestId(external), true);
	});
});

test('resolveRequestId replaces malformed external IDs', async () => {
	await withTestEnv(() => {
		const generated = resolveRequestId('not valid id!!!');
		assert.notEqual(generated, 'not valid id!!!');
		assert.match(generated, /^[0-9a-f-]{36}$/i);
		assert.equal(isValidRequestId('short'), false);
		assert.equal(isValidRequestId(''), false);
	});
});

test('logger output is JSON and redacts sensitive fields', async () => {
	await withTestEnv(() => {
		const lines = captureLogs(() => {
			getLogger().info(
				{
					cookie: 'session=super-secret-cookie-value',
					authorization: 'Bearer fake-jwt-token-value',
					password: 'hunter2',
					token: 'telegram-bot-token-12345',
					payosApiKey: 'payos-api-key-secret',
					r2SecretAccessKey: 'r2-secret-key',
					qstashToken: 'qstash-signing-token',
					note: 'safe-field'
				},
				'redaction test'
			);
		});

		assert.equal(lines.length, 1);
		const parsed = JSON.parse(lines[0]!);
		assert.equal(typeof parsed.time, 'string');
		assert.equal(parsed.note, 'safe-field');
		const serialized = JSON.stringify(parsed);
		assert.equal(serialized.includes('super-secret-cookie-value'), false);
		assert.equal(serialized.includes('fake-jwt-token-value'), false);
		assert.equal(serialized.includes('hunter2'), false);
		assert.equal(serialized.includes('telegram-bot-token-12345'), false);
		assert.equal(serialized.includes('payos-api-key-secret'), false);
		assert.equal(serialized.includes('r2-secret-key'), false);
		assert.equal(serialized.includes('qstash-signing-token'), false);
		assert.equal(serialized.includes('[REDACTED]'), true);
	});
});

test('logHttpRequest emits parseable JSON with required fields', async () => {
	await withTestEnv(() => {
		const lines = captureLogs(() => {
			logHttpRequest({
				requestId: 'req-12345678',
				method: 'GET',
				route: '/api/health/live',
				status: 200,
				durationMs: 12
			});
		});

		const parsed = JSON.parse(lines[0]!);
		assert.equal(parsed.requestId, 'req-12345678');
		assert.equal(parsed.method, 'GET');
		assert.equal(parsed.route, '/api/health/live');
		assert.equal(parsed.status, 200);
		assert.equal(parsed.durationMs, 12);
		assert.equal(parsed.service, 'roomio-api');
		assert.equal(typeof parsed.release, 'string');
	});
});

test('handle attaches x-request-id matching structured log', async () => {
	await withTestEnv(async () => {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				lines.push(String(chunk).trim());
				callback();
			}
		});
		setLoggerForTests(createLogger(stream));

		const externalId = 'client-req-abcdef12';
		const response = await handle({
			event: createEvent('/api/health/live', 'GET', externalId) as never,
			resolve: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
		});

		assert.equal(response.headers.get('x-request-id'), externalId);
		const httpLine = lines.find((line) => line.includes('"http request"'));
		assert.ok(httpLine);
		const parsed = JSON.parse(httpLine!);
		assert.equal(parsed.requestId, externalId);
	});
});

test('handleError returns generic 500 payload without stack or SQL', async () => {
	await withTestEnv(() => {
		const event = createEvent('/api/invoices', 'GET', undefined, 'server-error-123456') as never;

		const lines = captureLogs(() => {
			const result = handleError({
				error: new Error('SELECT * FROM users failed at postgres://secret@db:5432/roomio'),
				event,
				status: 500,
				message: 'Internal Error'
			});

			assert.deepEqual(result, {
				message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.',
				requestId: 'server-error-123456'
			});
			assert.equal(JSON.stringify(result).includes('SELECT'), false);
			assert.equal(JSON.stringify(result).includes('stack'), false);
			assert.equal(JSON.stringify(result).includes('postgres://'), false);
		});

		const errorLine = lines.find((line) => line.includes('unhandled request error'));
		assert.ok(errorLine);
		const parsed = JSON.parse(errorLine!);
		assert.equal(parsed.requestId, 'server-error-123456');
	});
});

test('log rotation defaults are safe and documented', () => {
	assert.equal(LOG_ROTATION_DEFAULTS.maxFileSizeMb > 0, true);
	assert.equal(LOG_ROTATION_DEFAULTS.rotatedFilesToKeep >= 7, true);
	assert.equal(LOG_ROTATION_DEFAULTS.retentionDays >= 14, true);
	assert.equal(LOG_ROTATION_DEFAULTS.compressRotated, true);
	assert.match(LOG_ROTATE_CONFIG_SNIPPET, /rotate 14/);
	assert.match(LOG_ROTATE_CONFIG_SNIPPET, /maxsize 50M/);
	assert.match(LOG_ROTATE_CONFIG_SNIPPET, /compress/);
});
