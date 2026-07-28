import assert from 'node:assert/strict';
import test from 'node:test';
import {
	PUBLIC_ROUTE_REGISTRY,
	isSessionExemptPublicRoute,
	listPublicRouteKeys,
	publicRouteKey
} from './machine-routes.js';

/** Frozen allowlist — update only when intentionally adding/removing session-exempt routes. */
const EXPECTED_PUBLIC_ROUTE_KEYS = [
	'POST /api/auth',
	'POST /api/auth/telegram',
	'POST /api/cron/monthly',
	'POST /api/payment-webhook',
	'POST /api/payos-webhook',
	'POST /api/payos-webhook/subscription',
	'POST /api/telegram/webhook'
] as const;

function parseRouteKey(key: string): { method: string; pathname: string } {
	const space = key.indexOf(' ');
	assert.notEqual(space, -1, `invalid route key: ${key}`);
	return { method: key.slice(0, space), pathname: key.slice(space + 1) };
}

test('registry keys match frozen allowlist exactly', () => {
	assert.deepEqual(listPublicRouteKeys(), [...EXPECTED_PUBLIC_ROUTE_KEYS]);
	assert.equal(PUBLIC_ROUTE_REGISTRY.size, EXPECTED_PUBLIC_ROUTE_KEYS.length);
});

test('every registered key returns true for exact method and pathname', () => {
	for (const key of EXPECTED_PUBLIC_ROUTE_KEYS) {
		const { method, pathname } = parseRouteKey(key);
		assert.equal(
			isSessionExemptPublicRoute(method, pathname),
			true,
			`expected session-exempt: ${key}`
		);
		assert.equal(PUBLIC_ROUTE_REGISTRY.has(key), true);
	}
});

test('wrong HTTP method on each registered pathname returns false', () => {
	const alternateMethods = ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
	for (const key of EXPECTED_PUBLIC_ROUTE_KEYS) {
		const { method, pathname } = parseRouteKey(key);
		for (const wrongMethod of alternateMethods) {
			if (wrongMethod === method) continue;
			assert.equal(
				isSessionExemptPublicRoute(wrongMethod, pathname),
				false,
				`wrong method must not be exempt: ${wrongMethod} ${pathname}`
			);
		}
	}
	assert.equal(isSessionExemptPublicRoute('GET', '/api/auth'), false);
	assert.equal(isSessionExemptPublicRoute('GET', '/api/cron/monthly'), false);
});

test('suffix path attacks return false', () => {
	const suffixAttacks: Array<{ method: string; pathname: string }> = [
		{ method: 'POST', pathname: '/api/cron/monthly-evil' },
		{ method: 'POST', pathname: '/api/cron/monthly/evil' },
		{ method: 'POST', pathname: '/api/payment-webhook/anything' },
		{ method: 'POST', pathname: '/api/payment-webhook/' },
		{ method: 'POST', pathname: '/api/telegram/webhook/extra' },
		{ method: 'POST', pathname: '/api/payos-webhook/evil' },
		{ method: 'POST', pathname: '/api/payos-webhook/subscription/extra' },
		{ method: 'POST', pathname: '/api/auth/extra-path' }
	];
	for (const { method, pathname } of suffixAttacks) {
		assert.equal(
			isSessionExemptPublicRoute(method, pathname),
			false,
			`suffix attack must not be exempt: ${method} ${pathname}`
		);
	}
});

test('prefix path attacks return false unless exact registered route', () => {
	const prefixAttacks: Array<{ method: string; pathname: string }> = [
		{ method: 'POST', pathname: '/api/cron' },
		{ method: 'POST', pathname: '/api/auth/extra' },
		{ method: 'POST', pathname: '/api/telegram' },
		{ method: 'POST', pathname: '/api/payos-webhook/' },
		{ method: 'POST', pathname: '/api' }
	];
	for (const { method, pathname } of prefixAttacks) {
		assert.equal(
			isSessionExemptPublicRoute(method, pathname),
			false,
			`prefix attack must not be exempt: ${method} ${pathname}`
		);
	}
});

test('publicRouteKey normalizes HTTP method casing', () => {
	assert.equal(publicRouteKey('post', '/api/auth'), 'POST /api/auth');
	assert.equal(publicRouteKey('PoSt', '/api/cron/monthly'), 'POST /api/cron/monthly');
	assert.equal(isSessionExemptPublicRoute('post', '/api/auth'), true);
	assert.equal(isSessionExemptPublicRoute('POST', '/api/auth'), true);
});

test('registry contains no QStash-related route keys', () => {
	const keys = listPublicRouteKeys();
	for (const key of keys) {
		assert.match(
			key.toLowerCase(),
			/^((?!qstash).)*$/,
			`unexpected QStash route in public registry: ${key}`
		);
	}
	const joined = keys.join('\n').toLowerCase();
	assert.equal(joined.includes('qstash'), false);
});
