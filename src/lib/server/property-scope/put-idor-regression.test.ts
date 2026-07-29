import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PROPERTIES_SRC = new URL('../../../routes/api/properties/+server.ts', import.meta.url);
const ROOMS_SRC = new URL('../../../routes/api/rooms/+server.ts', import.meta.url);

test('property PUT requires scoped property before block sync (B1)', () => {
	const src = readFileSync(PROPERTIES_SRC, 'utf8');
	const putBlock = src.match(/export const PUT[\s\S]*?(?=export const DELETE)/);
	assert.ok(putBlock, 'PUT handler found');
	assert.match(
		putBlock[0],
		/requireScopedProperty\(db, actorResult\.actor, id\)[\s\S]*blockNames && Array\.isArray\(blockNames\)/
	);
});

test('room PUT requires scoped room before response assembly (B2)', () => {
	const src = readFileSync(ROOMS_SRC, 'utf8');
	const putBlock = src.match(/export const PUT[\s\S]*?(?=export const DELETE)/);
	assert.ok(putBlock, 'PUT handler found');
	const body = putBlock[0];
	const scopeIdx = body.indexOf('requireScopedRoom(db, actorResult.actor, String(id))');
	const fetchIdx = body.indexOf('db.query.rooms.findFirst');
	assert.ok(scopeIdx >= 0, 'requireScopedRoom must be present');
	assert.ok(fetchIdx >= 0, 'response fetch must be present');
	assert.ok(scopeIdx < fetchIdx, 'scoped room gate must run before DTO fetch');
});
