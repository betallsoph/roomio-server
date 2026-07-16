import assert from 'node:assert/strict';
import test from 'node:test';

const {
	RENTAL_TYPES,
	canonicalRentalType,
	isValidRentalType,
	normalizeRentalTypeOr,
	parseEnabledRentalTypes
} = await import('./rental-types.js');

test('canonicalRentalType maps legacy aliases', () => {
	assert.equal(canonicalRentalType('coliving'), 'APARTMENT');
	assert.equal(canonicalRentalType(' COLIVING '), 'APARTMENT');
	assert.equal(canonicalRentalType('serviced_apartment'), 'MOTEL');
	assert.equal(canonicalRentalType('SERVICED_APARTMENT'), 'MOTEL');
	assert.equal(canonicalRentalType('motel'), 'MOTEL');
	assert.equal(canonicalRentalType('APARTMENT'), 'APARTMENT');
});

test('isValidRentalType accepts only canonical values', () => {
	for (const type of RENTAL_TYPES) {
		assert.equal(isValidRentalType(type), true);
	}
	assert.equal(isValidRentalType('COLIVING'), false);
	assert.equal(isValidRentalType('PENTHOUSE'), false);
});

test('normalizeRentalTypeOr falls back for invalid or non-string input', () => {
	assert.equal(normalizeRentalTypeOr('coliving'), 'APARTMENT');
	assert.equal(normalizeRentalTypeOr('PENTHOUSE'), 'APARTMENT');
	assert.equal(normalizeRentalTypeOr('WHOLE_UNIT'), 'WHOLE_UNIT');
	assert.equal(normalizeRentalTypeOr(undefined), 'APARTMENT');
	assert.equal(normalizeRentalTypeOr(null), 'APARTMENT');
	assert.equal(normalizeRentalTypeOr(42), 'APARTMENT');
	assert.equal(normalizeRentalTypeOr('invalid', 'DORM'), 'DORM');
});

test('parseEnabledRentalTypes handles dirty comma lists', () => {
	assert.deepEqual(parseEnabledRentalTypes(' coliving, MOTEL,, '), ['APARTMENT', 'MOTEL']);
	assert.deepEqual(parseEnabledRentalTypes('SERVICED_APARTMENT,DORM'), ['MOTEL', 'DORM']);
	assert.deepEqual(parseEnabledRentalTypes(''), ['APARTMENT']);
	assert.deepEqual(parseEnabledRentalTypes(null), ['APARTMENT']);
	assert.deepEqual(parseEnabledRentalTypes('PENTHOUSE,UNKNOWN'), ['APARTMENT']);
});
