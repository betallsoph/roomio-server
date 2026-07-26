import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

const { resetEnvForTests } = await import('./env.js');
resetEnvForTests({
	NODE_ENV: 'test',
	DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio',
	R2_ACCOUNT_ID: 'abcdabcdabcdabcdabcdabcdabcdabcd',
	R2_ACCESS_KEY_ID: 'access',
	R2_SECRET_ACCESS_KEY: 'secret',
	R2_BUCKET: 'roomio-uploads',
	R2_PUBLIC_BASE_URL: 'https://assets.example.com'
});

const { extractMeterValueFromText, isR2MeterPhotoUrl } = await import('./meter-ocr.js');

test('extractMeterValueFromText parses JSON value', () => {
	assert.equal(extractMeterValueFromText('{"value":12345}'), 12345);
	assert.equal(extractMeterValueFromText('```json\n{"value": 9876}\n```'), 9876);
});

test('extractMeterValueFromText picks largest digit group from free text', () => {
	assert.equal(extractMeterValueFromText('Chỉ số: 12.345 kWh'), 12345);
	assert.equal(extractMeterValueFromText('không có số'), null);
});

test('isR2MeterPhotoUrl validates meter upload path', () => {
	assert.equal(
		isR2MeterPhotoUrl('https://assets.example.com/uploads/meters/tenant/u1/2026/07/abc.jpg'),
		true
	);
	assert.equal(isR2MeterPhotoUrl('https://assets.example.com/uploads/other/x.jpg'), false);
	assert.equal(isR2MeterPhotoUrl('https://evil.example.com/uploads/meters/x.jpg'), false);
});
