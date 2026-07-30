import assert from 'node:assert/strict';
import test from 'node:test';
import { isStaffRouteAllowed } from './staff-allowlist.js';

test('AUTH-010 staff allowlist rejects prefix/suffix lookalikes', () => {
	for (const [pathname, method] of [
		['/api/properties-private', 'GET'],
		['/api/services-admin', 'GET'],
		['/api/rooms-extra', 'GET']
	] as const) {
		assert.equal(isStaffRouteAllowed(method, pathname), false, `${method} ${pathname}`);
	}
});

test('AUTH-010 staff allowlist rejects disallowed HTTP methods on valid prefixes', () => {
	for (const [pathname, method] of [
		['/api/properties', 'POST'],
		['/api/properties', 'DELETE'],
		['/api/rooms', 'PUT'],
		['/api/services', 'PUT']
	] as const) {
		assert.equal(isStaffRouteAllowed(method, pathname), false, `${method} ${pathname}`);
	}
});

test('AUTH-010 staff allowlist permits exact prefix and nested paths with allowed methods', () => {
	for (const [pathname, method] of [
		['/api/properties', 'GET'],
		['/api/properties/nested', 'GET'],
		['/api/rooms', 'GET'],
		['/api/services', 'GET']
	] as const) {
		assert.equal(isStaffRouteAllowed(method, pathname), true, `${method} ${pathname}`);
	}
});

test('AUTH-010 staff allowlist covers registered prefixes with allowed methods', () => {
	for (const [pathname, method] of [
		['/api/requests', 'GET'],
		['/api/requests/abc', 'PUT'],
		['/api/meter-readings', 'GET'],
		['/api/meter-readings/1', 'PUT'],
		['/api/tenants', 'GET'],
		['/api/upload', 'POST'],
		['/api/uploads/presign', 'POST']
	] as const) {
		assert.equal(isStaffRouteAllowed(method, pathname), true, `${method} ${pathname}`);
	}
});
