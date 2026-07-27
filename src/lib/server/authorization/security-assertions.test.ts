import assert from 'node:assert/strict';
import test from 'node:test';
import {
	FORBIDDEN_CLIENT_RESPONSE_KEYS,
	expectForeignResourceHidden,
	expectNoForbiddenKeys,
	findForbiddenKeys
} from './security-assertions.js';

test('findForbiddenKeys returns empty for safe nested payload', () => {
	const body = {
		id: 'room-1',
		tenant: { user: { id: 'u1', name: 'Tenant', email: 't@example.com' } },
		items: [{ name: 'Điện', amount: 100 }]
	};
	assert.deepEqual(findForbiddenKeys(body), []);
	expectNoForbiddenKeys(body);
});

test('findForbiddenKeys detects keys at arbitrary depth', () => {
	const body = {
		rooms: [
			{
				tenant: {
					user: { passwordHash: 'leak', name: 'A' }
				}
			}
		],
		meta: { nested: { payosApiKeyEnc: 'enc' } }
	};
	const hits = findForbiddenKeys(body);
	assert.equal(hits.length, 2);
	assert.ok(hits.some((h) => h.key === 'passwordHash' && h.path.includes('tenant')));
	assert.ok(hits.some((h) => h.key === 'payosApiKeyEnc'));
	assert.throws(() => expectNoForbiddenKeys(body), /Forbidden client response key/);
});

test('findForbiddenKeys scans every §9.3 key name', () => {
	for (const key of FORBIDDEN_CLIENT_RESPONSE_KEYS) {
		const hits = findForbiddenKeys({ wrapper: { [key]: 'x' } });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].key, key);
	}
});

test('expectForeignResourceHidden enforces status and id containment', async () => {
	const hidden = new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
	await expectForeignResourceHidden(hidden, { sensitiveIds: ['foreign-id-99'] });

	const leak = new Response(JSON.stringify({ error: 'foreign-id-99 leaked' }), { status: 404 });
	await assert.rejects(
		() => expectForeignResourceHidden(leak, { sensitiveIds: ['foreign-id-99'] }),
		/leaks sensitive id/
	);

	const wrongStatus = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
	await assert.rejects(() => expectForeignResourceHidden(wrongStatus), /404/);
});

test('expectForeignResourceHidden rejects forbidden keys in JSON error bodies', async () => {
	const bad = new Response(JSON.stringify({ error: 'x', passwordHash: 'leak' }), { status: 404 });
	await assert.rejects(() => expectForeignResourceHidden(bad), /Forbidden client response key/);
});
