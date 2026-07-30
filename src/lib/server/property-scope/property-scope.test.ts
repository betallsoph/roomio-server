import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { requireLandlordActor } from '../authorization/actor.js';
import { authorizationErrorToResponse, unauthenticatedError } from '../authorization/errors.js';

const PROPERTIES_SRC = new URL('../../../routes/api/properties/+server.ts', import.meta.url);
const ROOMS_SRC = new URL('../../../routes/api/rooms/+server.ts', import.meta.url);
const SERVICES_SRC = new URL('../../../routes/api/services/+server.ts', import.meta.url);

test('property-tree routes use locals.actor — never session landlordId', () => {
	for (const [label, src] of [
		['properties', readFileSync(PROPERTIES_SRC, 'utf8')],
		['rooms', readFileSync(ROOMS_SRC, 'utf8')],
		['services', readFileSync(SERVICES_SRC, 'utf8')]
	] as const) {
		assert.match(
			src,
			/requireOperationalActor\(locals\.actor\)/,
			`${label} GET must use requireOperationalActor(locals.actor)`
		);
		assert.doesNotMatch(
			src,
			/locals\.session\?\.landlordProfileId|requireLandlord\(locals\.session\)/,
			`${label} must not trust session landlordId`
		);
		assert.doesNotMatch(
			src,
			/url\.searchParams\.get\('landlordId'\)/,
			`${label} must not read landlordId from query for scope`
		);
	}
});

test('property-tree mutations require landlord actor from locals.actor', () => {
	for (const [label, src] of [
		['properties', readFileSync(PROPERTIES_SRC, 'utf8')],
		['rooms', readFileSync(ROOMS_SRC, 'utf8')],
		['services', readFileSync(SERVICES_SRC, 'utf8')]
	] as const) {
		assert.match(
			src,
			/requireLandlordMutationActor\(locals\.actor\)/,
			`${label} mutations must use requireLandlordMutationActor`
		);
	}
});

test('landlord mutation guard rejects staff via requireLandlordActor', () => {
	const staff = requireLandlordActor({
		kind: 'USER',
		userId: 's',
		role: 'STAFF',
		staffId: 'sid',
		landlordId: 'landlord-a',
		propertyIds: [],
		permissions: ['VIEW_ROOMS']
	});
	assert.equal(staff.ok, false);
});

test('unauthenticated actor maps to 401 response', () => {
	const response = authorizationErrorToResponse(unauthenticatedError());
	assert.equal(response.status, 401);
});
