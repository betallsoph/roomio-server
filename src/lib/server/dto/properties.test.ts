import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { toPropertyDto } from './properties.js';

test('toPropertyDto strips nested secrets and unknown columns', () => {
	const dto = toPropertyDto({
		id: 'prop-1',
		landlordId: 'landlord-1',
		name: 'Building',
		shortName: 'B',
		address: 'Addr',
		rentalType: 'APARTMENT',
		operatingModel: 'OWNED',
		createdAt: new Date('2026-01-01'),
		blocks: [{ id: 'block-1', propertyId: 'prop-1', name: 'A', passwordHash: 'x' } as never],
		rooms: [
			{
				id: 'room-1',
				roomNumber: '101',
				status: 'empty',
				roomType: 'standard',
				monthlyRent: 3_000_000,
				payosApiKeyEnc: 'secret'
			} as never
		]
	});

	expectNoForbiddenKeys(dto);
	assert.equal(dto.blocks[0]?.name, 'A');
	assert.equal(dto.rooms[0]?.roomNumber, '101');
});
