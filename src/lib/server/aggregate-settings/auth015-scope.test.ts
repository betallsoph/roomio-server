import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(fileURLToPath(new URL('../../../routes/api', import.meta.url)));

function readRoute(rel: string) {
	return readFileSync(path.join(root, rel), 'utf8');
}

test('AUTH-015 aggregate routes use locals.actor landlord guards', () => {
	for (const rel of ['dashboard/stats/+server.ts', 'finance/+server.ts']) {
		const src = readRoute(rel);
		assert.match(
			src,
			/requireLandlordMutationActor\(locals\.actor\)/,
			`${rel} must use actor guard`
		);
		assert.doesNotMatch(
			src,
			/requireLandlord\(locals\.session\)/,
			`${rel} must not use session landlordId`
		);
	}
});

test('AUTH-015 settings route uses allowlisted DTO mapper', () => {
	const src = readRoute('settings/+server.ts');
	assert.match(src, /pickSettingsWriteInput/);
	assert.match(src, /toSettingsDto/);
	assert.doesNotMatch(src, /return json\(landlordProfile\)/);
});

test('AUTH-015 automation POST ignores client landlordId', () => {
	const src = readRoute('automation/+server.ts');
	assert.match(src, /runAutomationJob\(landlordId/);
	assert.doesNotMatch(src, /body\.landlordId/);
});
