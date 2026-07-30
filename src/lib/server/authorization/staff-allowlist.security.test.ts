import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { StaffActor } from './actor.js';
import type { SessionData } from '../session.js';
import { resetEnvForTests } from '../env.js';
import { resetLoggerForTests } from '../logger/index.js';

const TEST_ENV = {
	NODE_ENV: 'test',
	DATABASE_URL: 'postgres://roomio:test@localhost:5432/roomio',
	SESSION_SECRET: 'session-secret-never-log-32chars-min!!',
	ORIGIN: 'http://localhost:3000',
	PUBLIC_APP_ORIGIN: 'http://localhost:5173'
};

const STAFF_SESSION: SessionData = {
	userId: 'staff-user',
	role: 'STAFF',
	landlordProfileId: null,
	tenantProfileId: null,
	staffProfileId: 'staff-1',
	staffLandlordId: 'landlord-1',
	enabledRentalTypes: null
};

const STAFF_ACTOR: StaffActor = {
	kind: 'USER',
	userId: 'staff-user',
	role: 'STAFF',
	staffId: 'staff-1',
	landlordId: 'landlord-1',
	propertyIds: [],
	permissions: []
};

function createEvent(pathname: string, method: string) {
	return {
		url: new URL(`http://localhost${pathname}`),
		request: new Request(`http://localhost${pathname}`, { method }),
		cookies: {
			get: () => 'signed-session',
			set: () => {},
			delete: () => {},
			serialize: () => '',
			getAll: () => []
		},
		locals: {} as App.Locals,
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

async function withStaffHooks<T>(fn: () => Promise<T>): Promise<T> {
	const previous = { ...process.env };
	Object.assign(process.env, TEST_ENV);
	resetEnvForTests();
	resetLoggerForTests();

	try {
		mock.module('$lib/server/session', {
			namedExports: {
				readSession: () => STAFF_SESSION,
				destroySession: () => {},
				createSession: () => {},
				SESSION_COOKIE: 'roomio_session'
			}
		});

		const loadUserActor = await import('./load-user-actor.js');
		mock.module('$lib/server/authorization/load-user-actor', {
			namedExports: {
				...loadUserActor,
				getUserActor: async () => STAFF_ACTOR,
				isTransitionalEnvSuperAdminSession: () => false
			}
		});

		return await fn();
	} finally {
		mock.restoreAll();
		process.env = previous;
		resetEnvForTests();
		resetLoggerForTests();
	}
}

test('AUTH-010 staff allowlist rejects prefix/suffix lookalikes', async () => {
	await withStaffHooks(async () => {
		const { handle } = await import('../../../hooks.server.js');

		for (const [pathname, method] of [
			['/api/properties-private', 'GET'],
			['/api/services-admin', 'GET'],
			['/api/rooms-extra', 'GET']
		] as const) {
			const response = await handle({
				event: createEvent(pathname, method) as never,
				resolve: async () => new Response('unexpected', { status: 200 })
			});
			assert.equal(response.status, 403, `${method} ${pathname}`);
			const body = await response.json();
			assert.equal(body.error, 'Nhân viên không có quyền thực hiện thao tác này');
		}
	});
});

test('AUTH-010 staff allowlist rejects disallowed HTTP methods on valid prefixes', async () => {
	await withStaffHooks(async () => {
		const { handle } = await import('../../../hooks.server.js');

		for (const [pathname, method] of [
			['/api/properties', 'POST'],
			['/api/properties', 'DELETE'],
			['/api/rooms', 'PUT'],
			['/api/services', 'PUT']
		] as const) {
			const response = await handle({
				event: createEvent(pathname, method) as never,
				resolve: async () => new Response('unexpected', { status: 200 })
			});
			assert.equal(response.status, 403, `${method} ${pathname}`);
		}
	});
});

test('AUTH-010 staff allowlist permits exact prefix and nested paths with allowed methods', async () => {
	await withStaffHooks(async () => {
		const { handle } = await import('../../../hooks.server.js');

		for (const [pathname, method] of [
			['/api/properties', 'GET'],
			['/api/properties/nested', 'GET'],
			['/api/rooms', 'GET'],
			['/api/services', 'GET']
		] as const) {
			const response = await handle({
				event: createEvent(pathname, method) as never,
				resolve: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
			});
			assert.equal(response.status, 200, `${method} ${pathname}`);
		}
	});
});
