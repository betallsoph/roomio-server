import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

const BOT_TOKEN = '123456:test-token';
const { resetEnvForTests } = await import('./env.js');
resetEnvForTests({
	NODE_ENV: 'test',
	DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio',
	BOT_TOKEN,
	BOT_USERNAME: 'roomio_bot',
	MINIAPP_SHORT_NAME: 'app'
});

const { TelegramAuthError, verifyInitData } = await import('./telegram.js');

function createInitData() {
	const params = new URLSearchParams({
		auth_date: String(Math.floor(Date.now() / 1000)),
		query_id: 'test-query',
		signature: 'telegram-ed25519-signature',
		start_param: 'invite-token',
		user: JSON.stringify({ id: 123456789, first_name: 'Tenant' })
	});
	const dataCheckString = [...params.entries()]
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join('\n');
	const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
	const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
	params.set('hash', hash);
	return params;
}

test('verifies current Telegram initData containing signature', () => {
	const verified = verifyInitData(createInitData().toString());

	assert.equal(verified.user.id, 123456789);
	assert.equal(verified.startParam, 'invite-token');
});

test('rejects initData changed after signing', () => {
	const params = createInitData();
	params.set('start_param', 'tampered-token');

	assert.throws(() => verifyInitData(params.toString()), TelegramAuthError);
});
