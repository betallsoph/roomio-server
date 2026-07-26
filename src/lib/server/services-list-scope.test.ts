import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SERVICES_SRC = new URL('../../routes/api/services/+server.ts', import.meta.url);

test('GET scopes listings via resolveLandlordScopeForList and session', () => {
	const src = readFileSync(SERVICES_SRC, 'utf8');

	assert.match(src, /import \{ resolveLandlordScopeForList \} from '\$lib\/server\/landlord-query-scope'/);
	assert.match(
		src,
		/export const GET[\s\S]*resolveLandlordScopeForList\(\s*locals\.session/
	);
	assert.match(
		src,
		/export const GET[\s\S]*url\.searchParams\.get\('landlordId'\)/
	);
	assert.match(src, /export const GET[\s\S]*eq\(services\.landlordId, scope\.landlordId\)/);
	assert.doesNotMatch(
		src,
		/export const GET[\s\S]*const landlordId = url\.searchParams\.get\('landlordId'\)/
	);
});

test('POST/PUT/DELETE unchanged — still scope via session landlord', () => {
	const src = readFileSync(SERVICES_SRC, 'utf8');

	assert.match(src, /export const POST[\s\S]*locals\.session\?\.landlordProfileId/);
	assert.match(
		src,
		/export const PUT[\s\S]*existing\.landlordId !== locals\.session\.landlordProfileId/
	);
	assert.match(
		src,
		/export const DELETE[\s\S]*existing\.landlordId !== locals\.session\.landlordProfileId/
	);
	assert.doesNotMatch(src, /export const POST[\s\S]*url\.searchParams\.get\('landlordId'\)/);
});
