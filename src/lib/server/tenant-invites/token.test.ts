import assert from 'node:assert/strict';
import test from 'node:test';
import { generateInviteToken, hashInviteToken } from './token.js';

test('hashInviteToken is stable and distinct from plaintext', () => {
	const token = generateInviteToken();
	const hash = hashInviteToken(token);
	assert.notEqual(token, hash);
	assert.equal(hashInviteToken(token), hash);
	assert.equal(hash.length, 64);
});

test('generateInviteToken produces unique values', () => {
	const a = generateInviteToken();
	const b = generateInviteToken();
	assert.notEqual(a, b);
});
