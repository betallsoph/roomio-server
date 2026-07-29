import assert from 'node:assert/strict';
import test from 'node:test';
import { expectNoForbiddenKeys } from '../authorization/security-assertions.js';
import { toMeterOcrDto } from './meter-ocr.js';
import { toMeterReadingDto, toMeterReadingListItemDto } from './meter-reading.js';
import { toMaintenanceRequestDto } from './maintenance-request.js';

test('toMeterOcrDto strips rawText debug field', () => {
	const dto = toMeterOcrDto({ value: 1234, rawText: '{"value":1234}', error: 'x' });
	assert.deepEqual(dto, { value: 1234, error: 'x' });
	expectNoForbiddenKeys(dto);
	assert.equal('rawText' in dto, false);
});

test('toMeterReadingDto strips ocrRawText', () => {
	const dto = toMeterReadingDto({
		id: 'mr-1',
		roomId: 'room-1',
		serviceId: 'svc-1',
		month: '2026-07',
		prevValue: 10,
		submittedValue: 20,
		currValue: 20,
		recordedAt: '2026-07-01',
		photoUrl: 'https://assets.example.com/uploads/meters/a.jpg',
		ocrParsedValue: 20,
		status: 'pending',
		submittedBy: 'TENANT',
		isAnomalous: false,
		managedTenantId: 'mt-1',
		tenancyId: 'ten-1',
		ocrRawText: 'secret debug'
	});
	expectNoForbiddenKeys(dto);
	assert.equal('ocrRawText' in dto, false);
});

test('toMeterReadingListItemDto keeps list enrichments only', () => {
	const dto = toMeterReadingListItemDto({
		id: 'mr-1',
		roomId: 'room-1',
		serviceId: 'svc-1',
		month: '2026-07',
		prevValue: 10,
		submittedValue: 20,
		currValue: 20,
		recordedAt: '2026-07-01',
		photoUrl: null,
		ocrParsedValue: null,
		status: 'approved',
		submittedBy: 'LANDLORD',
		isAnomalous: false,
		managedTenantId: null,
		tenancyId: null,
		roomNumber: '101',
		propertyName: 'A1',
		serviceName: 'Điện'
	});
	expectNoForbiddenKeys(dto);
	assert.equal(dto.roomNumber, '101');
});

test('toMaintenanceRequestDto exposes allowlisted nested user contact only', () => {
	const dto = toMaintenanceRequestDto({
		id: 'req-1',
		tenantId: 'tp-1',
		roomNumber: '101',
		buildingName: 'A1',
		category: 'plumbing',
		title: 'Leak',
		description: 'Water',
		imageUrl: null,
		status: 'pending',
		priority: 'normal',
		createdAt: new Date('2026-07-01T00:00:00.000Z'),
		updatedAt: new Date('2026-07-01T00:00:00.000Z'),
		response: null,
		assignedToId: null,
		managedTenantId: 'mt-1',
		tenancyId: 'ten-1',
		landlordId: 'landlord-1',
		propertyId: 'prop-1',
		roomId: 'room-1',
		tenant: {
			id: 'tp-1',
			user: {
				name: 'Tenant',
				phone: '0900000001',
				email: 'secret@example.com',
				passwordHash: 'nope'
			} as { name: string; phone: string }
		},
		assignedTo: null
	});
	expectNoForbiddenKeys(dto);
	assert.equal(dto.tenant?.user?.name, 'Tenant');
});
