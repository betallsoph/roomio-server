import type { EnvConfig } from '$lib/server/env';

export const REDACTED_VALUE = '[REDACTED]';

/** Pino redact paths — field names and headers that must never appear in logs. */
export const REDACT_PATHS = [
	'req.headers.cookie',
	'req.headers.authorization',
	'headers.cookie',
	'headers.authorization',
	'cookie',
	'authorization',
	'password',
	'token',
	'accessToken',
	'refreshToken',
	'sessionSecret',
	'apiKey',
	'checksumKey',
	'secretAccessKey',
	'botToken',
	'webhookSecret',
	'cronSecret',
	'signingKey',
	'rawPayload',
	'payload',
	'body',
	'*.password',
	'*.token',
	'*.cookie',
	'*.authorization',
	'*.apiKey',
	'*.checksumKey',
	'*.secretAccessKey',
	'*.botToken',
	'*.signingKey',
	'*.rawPayload',
	'payosApiKey',
	'payosChecksumKey',
	'payosClientId',
	'r2SecretAccessKey',
	'r2AccessKeyId',
	'qstashToken',
	'telegramBotToken',
	'googleAiApiKey'
] as const;

const SENSITIVE_KEY_NAMES = new Set([
	'authorization',
	'body',
	'cookie',
	'password',
	'passwd',
	'pwd',
	'payload',
	'rawpayload',
	'token',
	'accesstoken',
	'refreshtoken',
	'sessionsecret',
	'apikey',
	'checksumkey',
	'secretaccesskey',
	'bottoken',
	'webhooksecret',
	'cronsecret',
	'signingkey',
	'databaseurl',
	'connectionstring',
	'payosapikey',
	'payoschecksumkey',
	'r2secretaccesskey',
	'r2accesskeyid',
	'qstashtoken',
	'telegrambottoken',
	'googleaiapikey'
]);

function normalizeKey(key: string): string {
	return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizeKey(key);
	return (
		SENSITIVE_KEY_NAMES.has(normalized) ||
		normalized.includes('password') ||
		normalized.endsWith('secret') ||
		normalized.endsWith('token') ||
		normalized.endsWith('apikey') ||
		normalized.endsWith('privatekey')
	);
}

function addSecret(target: Set<string>, value: string | null | undefined): void {
	const normalized = value?.trim();
	// Very short values cause false-positive replacements in ordinary log prose.
	if (normalized && normalized.length >= 8) target.add(normalized);
}

/** Resolve configured credentials once when a logger is constructed. */
export function collectSensitiveLogValues(env: EnvConfig): string[] {
	const values = new Set<string>();
	addSecret(values, env.databaseUrl);
	addSecret(values, env.sessionSecret);
	addSecret(values, env.cronSecret);
	addSecret(values, env.superAdminAccounts);
	addSecret(values, env.payosEncryptionKey);

	try {
		const databaseUrl = new URL(env.databaseUrl);
		addSecret(values, decodeURIComponent(databaseUrl.username));
		addSecret(values, decodeURIComponent(databaseUrl.password));
	} catch {
		// Invalid DATABASE_URL is rejected by env validation. Logging must still never throw.
	}

	for (const account of env.superAdminAccounts?.split(',') ?? []) {
		const [, password] = account.split(':');
		addSecret(values, password);
	}

	if (env.payos.status === 'CONFIGURED') {
		addSecret(values, env.payos.clientId);
		addSecret(values, env.payos.apiKey);
		addSecret(values, env.payos.checksumKey);
	}
	if (env.r2.status === 'CONFIGURED') {
		addSecret(values, env.r2.accessKeyId);
		addSecret(values, env.r2.secretAccessKey);
	}
	if (env.telegram.status === 'CONFIGURED') {
		addSecret(values, env.telegram.botToken);
		addSecret(values, env.telegram.webhookSecret);
	}
	if (env.qstash.status === 'CONFIGURED') {
		addSecret(values, env.qstash.token);
		addSecret(values, env.qstash.currentSigningKey);
		addSecret(values, env.qstash.nextSigningKey);
	}
	if (env.ocr.status === 'CONFIGURED') addSecret(values, env.ocr.apiKey);

	return [...values].sort((left, right) => right.length - left.length);
}

export function scrubSensitiveText(value: string, sensitiveValues: readonly string[] = []): string {
	let scrubbed = value;
	for (const secret of sensitiveValues) {
		scrubbed = scrubbed.split(secret).join(REDACTED_VALUE);
	}

	return scrubbed
		.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]')
		.replace(/\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@[^\s"'<>]+/gi, '[REDACTED_CREDENTIAL_URL]')
		.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
		.replace(/https:\/\/api\.telegram\.org\/bot\d+:[A-Za-z0-9_-]+/gi, '[REDACTED_TELEGRAM_URL]')
		.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
		.replace(
			/((?:password|passwd|pwd|token|secret|api[_-]?key|checksum[_-]?key|authorization|cookie)\s*["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
			'$1[REDACTED]'
		)
		.replace(
			/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
			'[REDACTED_PRIVATE_KEY]'
		);
}

/**
 * Convert log values to JSON-safe structures while scrubbing values at every depth.
 * In particular, Error.message and Error.stack are non-enumerable and would bypass
 * ordinary object traversal, so they are copied and scrubbed explicitly.
 */
export function sanitizeLogValue(
	value: unknown,
	sensitiveValues: readonly string[] = [],
	seen: WeakSet<object> = new WeakSet<object>(),
	depth = 0
): unknown {
	if (typeof value === 'string') return scrubSensitiveText(value, sensitiveValues);
	if (
		value === null ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'undefined'
	) {
		return value;
	}
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'symbol' || typeof value === 'function') return String(value);
	if (depth >= 20) return '[TRUNCATED]';

	const objectValue = value as object;
	if (seen.has(objectValue)) return '[CIRCULAR]';
	seen.add(objectValue);

	if (value instanceof Date) return value.toISOString();
	if (value instanceof URL) return scrubSensitiveText(value.toString(), sensitiveValues);
	if (value instanceof Uint8Array) return `[BINARY:${value.byteLength}]`;

	if (value instanceof Error) {
		const result: Record<string, unknown> = {
			type: scrubSensitiveText(value.name, sensitiveValues),
			message: scrubSensitiveText(value.message, sensitiveValues)
		};
		if (value.stack) result.stack = scrubSensitiveText(value.stack, sensitiveValues);
		if ('code' in value)
			result.code = sanitizeLogValue(value.code, sensitiveValues, seen, depth + 1);
		if (value.cause !== undefined) {
			result.cause = sanitizeLogValue(value.cause, sensitiveValues, seen, depth + 1);
		}
		for (const [key, nested] of Object.entries(value)) {
			if (key in result) continue;
			result[key] = isSensitiveKey(key)
				? REDACTED_VALUE
				: sanitizeLogValue(nested, sensitiveValues, seen, depth + 1);
		}
		return result;
	}

	if (Array.isArray(value)) {
		return value.map((nested) => sanitizeLogValue(nested, sensitiveValues, seen, depth + 1));
	}

	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		result[key] = isSensitiveKey(key)
			? REDACTED_VALUE
			: sanitizeLogValue(nested, sensitiveValues, seen, depth + 1);
	}
	return result;
}
