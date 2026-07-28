import assert from 'node:assert/strict';
import test from 'node:test';
import {
	EnvValidationError,
	getApiOrigin,
	getPayosWebhookUrl,
	getPublicAppOrigin,
	parseEnv,
	resetEnvForTests
} from './env.js';

const VALID_PROD_ENV: NodeJS.ProcessEnv = {
	NODE_ENV: 'production',
	DATABASE_URL: 'postgres://roomio:super-secret-db-pass@db.private.network:5432/roomio',
	SESSION_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
	ORIGIN: 'https://api.roomio.example.com',
	PUBLIC_APP_ORIGIN: 'https://app.roomio.example.com',
	SUPER_ADMIN_ACCOUNTS: 'owner@example.com:a-long-random-owner-passphrase-2026'
};

function withBaseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...VALID_PROD_ENV, ...overrides };
}

test('parseEnv accepts valid production configuration', () => {
	const env = parseEnv(VALID_PROD_ENV);
	assert.equal(env.isProduction, true);
	assert.equal(env.origin, 'https://api.roomio.example.com');
	assert.equal(env.publicAppOrigin, 'https://app.roomio.example.com');
});

test('parseEnv rejects each missing required production variable by name only', () => {
	const requiredVars = [
		'DATABASE_URL',
		'SESSION_SECRET',
		'ORIGIN',
		'PUBLIC_APP_ORIGIN',
		'SUPER_ADMIN_ACCOUNTS'
	] as const;

	for (const missingVar of requiredVars) {
		const env = { ...VALID_PROD_ENV };
		delete env[missingVar];
		assert.throws(
			() => parseEnv(env),
			(error: unknown) => {
				assert.ok(error instanceof EnvValidationError);
				assert.ok(error.variableNames.includes(missingVar));
				assert.equal(error.message.includes('super-secret'), false);
				return true;
			},
			`expected missing ${missingVar}`
		);
	}
});

test('parseEnv rejects placeholder SESSION_SECRET and DATABASE_URL in production', () => {
	for (const sessionSecret of [
		'roomio-dev-secret-change-in-production',
		'local-dev-only-session-secret-32chars-min!!',
		'change_me_to_a_secure_random_string_in_production',
		'short'
	]) {
		assert.throws(
			() => parseEnv(withBaseEnv({ SESSION_SECRET: sessionSecret })),
			(error: unknown) => {
				assert.ok(error instanceof EnvValidationError);
				assert.ok(error.variableNames.includes('SESSION_SECRET'));
				assert.equal(error.message.includes(sessionSecret), false);
				return true;
			}
		);
	}

	assert.throws(
		() =>
			parseEnv(
				withBaseEnv({
					DATABASE_URL: 'postgres://roomio:matkhau@localhost:5432/roomio'
				})
			),
		(error: unknown) => {
			assert.ok(error instanceof EnvValidationError);
			assert.ok(error.variableNames.includes('DATABASE_URL'));
			assert.equal(error.message.includes('matkhau'), false);
			return true;
		}
	);
});

test('production rejects unsafe SuperAdmin credentials without logging their value', () => {
	const unsafe = 'admin@example.com:doi-mat-khau-dai-va-kho-doan:Super Admin';
	assert.throws(
		() => parseEnv(withBaseEnv({ SUPER_ADMIN_ACCOUNTS: unsafe })),
		(error: unknown) => {
			assert.ok(error instanceof EnvValidationError);
			assert.ok(error.variableNames.includes('SUPER_ADMIN_ACCOUNTS'));
			assert.equal(error.message.includes(unsafe), false);
			return true;
		}
	);

	const valid = parseEnv(
		withBaseEnv({
			SUPER_ADMIN_ACCOUNTS: 'owner@example.com:a-long-random-owner-passphrase-2026'
		})
	);
	assert.equal(valid.superAdminAccounts?.startsWith('owner@example.com:'), true);
});

test('allowEnvSuperAdmin is true only in development with SUPER_ADMIN_ACCOUNTS', () => {
	const dev = parseEnv({
		NODE_ENV: 'development',
		SUPER_ADMIN_ACCOUNTS: 'dev@example.com:dev-password-long-enough'
	});
	assert.equal(dev.allowEnvSuperAdmin, true);

	const staging = parseEnv({
		NODE_ENV: 'staging',
		SUPER_ADMIN_ACCOUNTS: 'dev@example.com:dev-password-long-enough'
	});
	assert.equal(staging.allowEnvSuperAdmin, false);

	const prod = parseEnv(
		withBaseEnv({
			SUPER_ADMIN_ACCOUNTS: 'owner@example.com:a-long-random-owner-passphrase-2026'
		})
	);
	assert.equal(prod.allowEnvSuperAdmin, false);
});

test('parseEnv rejects localhost DATABASE_URL in production', () => {
	assert.throws(
		() =>
			parseEnv(
				withBaseEnv({
					DATABASE_URL: 'postgres://roomio:super-secret-db-pass@localhost:5432/roomio'
				})
			),
		(error: unknown) => {
			assert.ok(error instanceof EnvValidationError);
			assert.ok(error.variableNames.includes('DATABASE_URL'));
			return true;
		}
	);
});

test('parseEnv allows local/test boot with safe fake env', () => {
	const env = parseEnv({
		NODE_ENV: 'test',
		DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio_test'
	});
	assert.equal(env.isProduction, false);
	assert.equal(env.sessionSecret.length >= 32, true);
	assert.equal(env.origin, 'http://localhost:3000');
});

test('half-configured feature groups fail in production', () => {
	assert.throws(
		() =>
			parseEnv(
				withBaseEnv({
					PAYOS_CLIENT_ID: 'client-only',
					R2_ACCOUNT_ID: 'abcdabcdabcdabcdabcdabcdabcdabcd',
					BOT_TOKEN: '123:abc'
				})
			),
		(error: unknown) => {
			assert.ok(error instanceof EnvValidationError);
			assert.ok(error.variableNames.includes('PAYOS_API_KEY'));
			assert.ok(error.variableNames.includes('PAYOS_CHECKSUM_KEY'));
			assert.ok(error.variableNames.includes('R2_ACCESS_KEY_ID'));
			assert.ok(error.variableNames.includes('BOT_USERNAME'));
			return true;
		}
	);
});

test('half-configured feature groups are NOT_CONFIGURED outside production', () => {
	const env = parseEnv({
		NODE_ENV: 'development',
		DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio',
		PAYOS_CLIENT_ID: 'client-only',
		R2_BUCKET: 'roomio-uploads'
	});
	assert.equal(env.payos.status, 'NOT_CONFIGURED');
	assert.equal(env.r2.status, 'NOT_CONFIGURED');
});

test('platform PayOS and per-landlord encryption are independent feature groups', () => {
	const platformOnly = parseEnv(
		withBaseEnv({
			PAYOS_CLIENT_ID: 'platform-client',
			PAYOS_API_KEY: 'platform-api-key',
			PAYOS_CHECKSUM_KEY: 'platform-checksum-key'
		})
	);
	assert.equal(platformOnly.payos.status, 'CONFIGURED');
	assert.equal(platformOnly.payosEncryptionKey, null);

	const encryptionOnly = parseEnv(
		withBaseEnv({ PAYOS_ENC_KEY: 'per-landlord-encryption-key-at-least-32-characters' })
	);
	assert.equal(encryptionOnly.payos.status, 'NOT_CONFIGURED');
	assert.equal(
		encryptionOnly.payosEncryptionKey,
		'per-landlord-encryption-key-at-least-32-characters'
	);

	assert.throws(
		() => parseEnv(withBaseEnv({ PAYOS_ENC_KEY: 'change_me' })),
		(error: unknown) =>
			error instanceof EnvValidationError && error.variableNames.includes('PAYOS_ENC_KEY')
	);
});

test('Telegram webhook secret is required when Telegram is enabled in production', () => {
	const telegram = {
		BOT_TOKEN: '123456:telegram-token',
		BOT_USERNAME: 'roomio_bot',
		MINIAPP_SHORT_NAME: 'app'
	};
	assert.throws(
		() => parseEnv(withBaseEnv(telegram)),
		(error: unknown) =>
			error instanceof EnvValidationError && error.variableNames.includes('TELEGRAM_WEBHOOK_SECRET')
	);
	const valid = parseEnv(
		withBaseEnv({
			...telegram,
			TELEGRAM_WEBHOOK_SECRET: 'tg-hook-4f17c08d9e26b63a'
		})
	);
	assert.equal(valid.telegram.status, 'CONFIGURED');
});

test('production validates origins, R2 identifiers and log level at boot', () => {
	for (const [name, overrides] of [
		['ORIGIN', { ORIGIN: 'not-a-url' }],
		['PUBLIC_APP_ORIGIN', { PUBLIC_APP_ORIGIN: 'http://app.roomio.example.com' }],
		['LOG_LEVEL', { LOG_LEVEL: 'verbose' }],
		[
			'R2_ACCOUNT_ID',
			{
				R2_ACCOUNT_ID: 'not-an-account-id',
				R2_ACCESS_KEY_ID: 'access',
				R2_SECRET_ACCESS_KEY: 'secret',
				R2_BUCKET: 'bucket',
				R2_PUBLIC_BASE_URL: 'https://assets.roomio.example.com'
			}
		]
	] as const) {
		assert.throws(
			() => parseEnv(withBaseEnv(overrides)),
			(error: unknown) => error instanceof EnvValidationError && error.variableNames.includes(name)
		);
	}
});

test('origin precedence and PayOS webhook helper are unified', () => {
	resetEnvForTests({
		NODE_ENV: 'test',
		DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio',
		ORIGIN: 'https://api.roomio.example.com',
		PUBLIC_APP_ORIGIN: 'https://app.roomio.example.com'
	});

	assert.equal(getApiOrigin(), 'https://api.roomio.example.com');
	assert.equal(getPublicAppOrigin(), 'https://app.roomio.example.com');
	assert.equal(getPayosWebhookUrl(), 'https://api.roomio.example.com/api/payos-webhook');

	resetEnvForTests({
		NODE_ENV: 'test',
		DATABASE_URL: 'postgres://roomio:roomio@localhost:5432/roomio',
		PUBLIC_APP_ORIGIN: 'https://app-only.roomio.example.com'
	});
	assert.equal(getApiOrigin(), 'http://localhost:3000');
	assert.equal(getPublicAppOrigin(), 'https://app-only.roomio.example.com');
});

test('validateEnvOrExit logs variable names without secret values', async () => {
	const logs: string[] = [];
	const originalError = console.error;
	const originalExit = process.exit;
	console.error = (...args: unknown[]) => {
		logs.push(args.map(String).join(' '));
	};
	process.exit = ((code?: number) => {
		throw new Error(`exit:${code ?? 0}`);
	}) as typeof process.exit;

	try {
		resetEnvForTests();
		const { validateEnvOrExit } = await import('./env.js');
		assert.throws(() => {
			validateEnvOrExit({
				NODE_ENV: 'production',
				SESSION_SECRET: 'roomio-dev-secret-change-in-production',
				DATABASE_URL: 'postgres://roomio:super-secret-value@db.private.network:5432/roomio',
				ORIGIN: 'https://api.roomio.example.com',
				PUBLIC_APP_ORIGIN: 'https://app.roomio.example.com'
			});
		}, /exit:1/);
	} finally {
		console.error = originalError;
		process.exit = originalExit;
		resetEnvForTests();
	}

	const output = logs.join('\n');
	assert.match(output, /SESSION_SECRET/);
	assert.equal(output.includes('roomio-dev-secret-change-in-production'), false);
	assert.equal(output.includes('super-secret-value'), false);
});
