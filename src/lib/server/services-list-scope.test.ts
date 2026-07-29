import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SERVICES_SRC = new URL('../../routes/api/services/+server.ts', import.meta.url);

test('GET scopes listings via requireOperationalActor and SQL landlord filter', () => {
	const src = readFileSync(SERVICES_SRC, 'utf8');

	assert.match(
		src,
		/import \{[\s\S]*listServicesForActor[\s\S]*\} from '\$lib\/server\/property-scope'/
	);
	assert.match(src, /export const GET[\s\S]*requireOperationalActor\(locals\.actor\)/);
	assert.match(src, /export const GET[\s\S]*listServicesForActor\(db, actorResult\.actor\)/);
	assert.doesNotMatch(src, /resolveLandlordScopeForList/);
	assert.doesNotMatch(src, /url\.searchParams\.get\('landlordId'\)/);
});

test('POST/PUT/DELETE use landlord actor from locals.actor', () => {
	const src = readFileSync(SERVICES_SRC, 'utf8');

	assert.match(src, /export const POST[\s\S]*requireLandlordMutationActor\(locals\.actor\)/);
	assert.match(src, /export const PUT[\s\S]*updateServiceScoped/);
	assert.match(src, /export const DELETE[\s\S]*deleteServiceScoped/);
	assert.doesNotMatch(src, /locals\.session\?\.landlordProfileId/);
});
