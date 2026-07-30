import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { toServiceDto, toServiceListDto } from './services.js';

test('toServiceDto is explicit allowlist', () => {
	const dto = toServiceDto({
		id: 'svc-1',
		landlordId: 'landlord-1',
		name: 'Điện',
		type: 'METERED',
		defaultRate: 3500,
		isActive: true,
		passwordHash: 'leaked'
	} as never);
	assert.ok(dto);
	expectNoForbiddenKeys(dto);
	assert.equal('passwordHash' in dto, false);
});

test('toServiceListDto maps arrays without leaking secrets', () => {
	const list = toServiceListDto([
		{
			id: 'svc-1',
			landlordId: 'landlord-1',
			name: 'Nước',
			type: 'METERED',
			defaultRate: 20000,
			isActive: true
		}
	]);
	expectNoForbiddenKeys(list);
	assert.equal(list.length, 1);
});
