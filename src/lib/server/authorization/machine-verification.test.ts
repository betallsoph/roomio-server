import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createMachineActor,
	extractPayOSOrderIdentifiers,
	parsePayOSWebhookBody,
	redactMachineDetail,
	timingSafeEqualString,
	verifyCronSecret,
	verifySharedSecret,
	verifyTelegramWebhookSecret
} from './machine-verification.js';

test('timingSafeEqualString accepts equal strings and rejects mismatches', () => {
	assert.equal(
		timingSafeEqualString('cron-secret-value-32chars-min', 'cron-secret-value-32chars-min'),
		true
	);
	assert.equal(
		timingSafeEqualString('cron-secret-value-32chars-min', 'cron-secret-value-32chars-mix'),
		false
	);
	assert.equal(timingSafeEqualString('short', 'longer-value'), false);
});

test('verifySharedSecret rejects missing values', () => {
	assert.equal(verifySharedSecret(null, 'expected-secret'), false);
	assert.equal(verifySharedSecret(undefined, 'expected-secret'), false);
	assert.equal(verifySharedSecret('', 'expected-secret'), false);
});

test('verifyCronSecret and verifyTelegramWebhookSecret use constant-time compare', () => {
	const secret = 'telegram-webhook-secret-never-log';
	assert.equal(verifyCronSecret(secret, secret), true);
	assert.equal(verifyCronSecret('wrong-secret-value-32chars-min', secret), false);
	assert.equal(verifyTelegramWebhookSecret(secret, secret), true);
	assert.equal(verifyTelegramWebhookSecret('tampered-secret-value-32chars', secret), false);
});

test('parsePayOSWebhookBody requires data and signature', () => {
	assert.equal(parsePayOSWebhookBody(null), null);
	assert.equal(parsePayOSWebhookBody({}), null);
	assert.equal(parsePayOSWebhookBody({ data: {}, signature: 'sig' })?.signature, 'sig');
	assert.equal(parsePayOSWebhookBody({ data: { orderCode: 1 } }), null);
});

test('extractPayOSOrderIdentifiers derives stable provider transaction id', () => {
	const ids = extractPayOSOrderIdentifiers({
		orderCode: 123,
		paymentLinkId: 'plink-1',
		amount: 50000,
		transactionDateTime: '2026-07-30T10:00:00'
	});
	assert.equal(ids.orderCode, '123');
	assert.equal(ids.paymentLinkId, 'plink-1');
	assert.equal(ids.amount, 50000);
	assert.equal(ids.providerTransactionId, '123:plink-1:2026-07-30T10:00:00:50000');
});

test('createMachineActor carries verified account scope', () => {
	const actor = createMachineActor('PAYMENT_WEBHOOK', 'req-1', {
		verifiedAccountId: 'acct-1'
	});
	assert.deepEqual(actor, {
		kind: 'MACHINE',
		channel: 'PAYMENT_WEBHOOK',
		requestId: 'req-1',
		verifiedAccountId: 'acct-1'
	});
});

test('redactMachineDetail strips secrets and raw payloads', () => {
	const redacted = redactMachineDetail({
		orderCode: '123',
		rawPayload: '{"secret":"leak"}',
		signature: 'abc',
		cronSecret: 'hidden'
	});
	assert.equal(redacted.orderCode, '123');
	assert.equal(redacted.rawPayload, '[REDACTED]');
	assert.equal(redacted.signature, '[REDACTED]');
	assert.equal(redacted.cronSecret, '[REDACTED]');
});
