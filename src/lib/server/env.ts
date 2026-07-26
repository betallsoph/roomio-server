const SESSION_SECRET_MIN_LENGTH = 32;

const SESSION_SECRET_PLACEHOLDERS = new Set([
	'roomio-dev-secret-change-in-production',
	'change_me_to_a_secure_random_string_in_production',
	'doi-chuoi-nay-o-production',
	'change_me',
	'changeme',
	'secret',
	'your-secret-here'
]);

const DATABASE_PASSWORD_PLACEHOLDERS = [
	'matkhau',
	'matkhau_change_me_in_production',
	'change_me',
	'changeme',
	'password',
	'postgres',
	'roomio'
];

const PAYOS_VARS = ['PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY'] as const;
const R2_VARS = [
	'R2_ACCOUNT_ID',
	'R2_ACCESS_KEY_ID',
	'R2_SECRET_ACCESS_KEY',
	'R2_BUCKET',
	'R2_PUBLIC_BASE_URL'
] as const;
const TELEGRAM_VARS = ['BOT_TOKEN', 'BOT_USERNAME', 'MINIAPP_SHORT_NAME'] as const;
const QSTASH_VARS = ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'] as const;
const OCR_VARS = ['GOOGLE_AI_API_KEY'] as const;

const DEV_SESSION_SECRET = 'roomio-local-dev-secret-32chars-min!!';
const DEV_DATABASE_URL = 'postgres://roomio:roomio@localhost:5432/roomio';
const DEV_ORIGIN = 'http://localhost:3000';
const DEV_PUBLIC_APP_ORIGIN = 'http://localhost:5173';

export type FeatureStatus = 'CONFIGURED' | 'NOT_CONFIGURED';

export interface PayOSFeatureConfig {
	status: 'CONFIGURED';
	clientId: string;
	apiKey: string;
	checksumKey: string;
	apiBase: string;
	encKey: string | null;
	partnerCode: string | null;
}

export interface R2FeatureConfig {
	status: 'CONFIGURED';
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
	publicBaseUrl: string;
	maxUploadBytes: number;
	presignExpiresSeconds: number;
}

export interface TelegramFeatureConfig {
	status: 'CONFIGURED';
	botToken: string;
	botUsername: string;
	miniappShortName: string;
	webhookSecret: string | null;
}

export interface QStashFeatureConfig {
	status: 'CONFIGURED';
	token: string;
	currentSigningKey: string;
	nextSigningKey: string;
}

export interface OcrFeatureConfig {
	status: 'CONFIGURED';
	apiKey: string;
	meterModel: string;
}

export type FeatureConfig<T extends FeatureStatus> = T extends 'CONFIGURED'
	? { status: 'CONFIGURED' } & Record<string, unknown>
	: { status: 'NOT_CONFIGURED' };

export interface EnvConfig {
	nodeEnv: string;
	isProduction: boolean;
	databaseUrl: string;
	sessionSecret: string;
	origin: string;
	publicAppOrigin: string;
	cronSecret: string | null;
	payos: PayOSFeatureConfig | { status: 'NOT_CONFIGURED' };
	r2: R2FeatureConfig | { status: 'NOT_CONFIGURED' };
	telegram: TelegramFeatureConfig | { status: 'NOT_CONFIGURED' };
	qstash: QStashFeatureConfig | { status: 'NOT_CONFIGURED' };
	ocr: OcrFeatureConfig | { status: 'NOT_CONFIGURED' };
}

export class EnvValidationError extends Error {
	constructor(public readonly variableNames: string[]) {
		super(`Invalid environment configuration: ${variableNames.join(', ')}`);
		this.name = 'EnvValidationError';
	}
}

function trim(value: string | undefined): string {
	return value?.trim() ?? '';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeOrigin(value: string): string {
	return value.replace(/\/+$/, '');
}

function isPlaceholderSessionSecret(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return SESSION_SECRET_PLACEHOLDERS.has(normalized);
}

function databaseUrlHasPlaceholderPassword(url: string): boolean {
	try {
		const parsed = new URL(url);
		const password = decodeURIComponent(parsed.password).toLowerCase();
		if (!password) return true;
		return DATABASE_PASSWORD_PLACEHOLDERS.some(
			(placeholder) => password === placeholder || password.includes(placeholder)
		);
	} catch {
		return true;
	}
}

function databaseUrlUsesLocalhost(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === 'localhost' || host === '127.0.0.1' || host === '::1';
	} catch {
		return false;
	}
}

function readFeatureGroup<T extends readonly string[]>(
	source: NodeJS.ProcessEnv,
	varNames: T
): { values: Record<T[number], string>; present: string[]; missing: string[] } {
	const values = {} as Record<T[number], string>;
	const present: string[] = [];
	const missing: string[] = [];

	for (const name of varNames) {
		const value = trim(source[name]);
		values[name as T[number]] = value;
		if (value) present.push(name);
		else missing.push(name);
	}

	return { values, present, missing };
}

function parsePayosFeature(
	source: NodeJS.ProcessEnv,
	isProduction: boolean,
	errors: string[]
): PayOSFeatureConfig | { status: 'NOT_CONFIGURED' } {
	const group = readFeatureGroup(source, PAYOS_VARS);
	if (group.present.length === 0) return { status: 'NOT_CONFIGURED' };
	if (group.missing.length > 0) {
		if (isProduction) errors.push(...group.missing);
		return { status: 'NOT_CONFIGURED' };
	}

	const encKey = trim(source.PAYOS_ENC_KEY) || null;
	if (isProduction && !encKey) errors.push('PAYOS_ENC_KEY');

	return {
		status: 'CONFIGURED',
		clientId: group.values.PAYOS_CLIENT_ID,
		apiKey: group.values.PAYOS_API_KEY,
		checksumKey: group.values.PAYOS_CHECKSUM_KEY,
		apiBase: trim(source.PAYOS_API_BASE) || 'https://api-merchant.payos.vn',
		encKey,
		partnerCode: trim(source.PAYOS_PARTNER_CODE) || null
	};
}

function parseR2Feature(
	source: NodeJS.ProcessEnv,
	isProduction: boolean,
	errors: string[]
): R2FeatureConfig | { status: 'NOT_CONFIGURED' } {
	const group = readFeatureGroup(source, R2_VARS);
	if (group.present.length === 0) return { status: 'NOT_CONFIGURED' };
	if (group.missing.length > 0) {
		if (isProduction) errors.push(...group.missing);
		return { status: 'NOT_CONFIGURED' };
	}

	return {
		status: 'CONFIGURED',
		accountId: group.values.R2_ACCOUNT_ID,
		accessKeyId: group.values.R2_ACCESS_KEY_ID,
		secretAccessKey: group.values.R2_SECRET_ACCESS_KEY,
		bucket: group.values.R2_BUCKET,
		publicBaseUrl: normalizeOrigin(group.values.R2_PUBLIC_BASE_URL),
		maxUploadBytes: parsePositiveInt(source.R2_UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
		presignExpiresSeconds: Math.min(
			parsePositiveInt(source.R2_PRESIGN_EXPIRES_SECONDS, 300),
			60 * 60
		)
	};
}

function parseTelegramFeature(
	source: NodeJS.ProcessEnv,
	isProduction: boolean,
	errors: string[]
): TelegramFeatureConfig | { status: 'NOT_CONFIGURED' } {
	const group = readFeatureGroup(source, TELEGRAM_VARS);
	if (group.present.length === 0) return { status: 'NOT_CONFIGURED' };
	if (group.missing.length > 0) {
		if (isProduction) errors.push(...group.missing);
		return { status: 'NOT_CONFIGURED' };
	}

	return {
		status: 'CONFIGURED',
		botToken: group.values.BOT_TOKEN,
		botUsername: group.values.BOT_USERNAME,
		miniappShortName: group.values.MINIAPP_SHORT_NAME,
		webhookSecret: trim(source.TELEGRAM_WEBHOOK_SECRET) || null
	};
}

function parseQStashFeature(
	source: NodeJS.ProcessEnv,
	isProduction: boolean,
	errors: string[]
): QStashFeatureConfig | { status: 'NOT_CONFIGURED' } {
	const group = readFeatureGroup(source, QSTASH_VARS);
	if (group.present.length === 0) return { status: 'NOT_CONFIGURED' };
	if (group.missing.length > 0) {
		if (isProduction) errors.push(...group.missing);
		return { status: 'NOT_CONFIGURED' };
	}

	return {
		status: 'CONFIGURED',
		token: group.values.QSTASH_TOKEN,
		currentSigningKey: group.values.QSTASH_CURRENT_SIGNING_KEY,
		nextSigningKey: group.values.QSTASH_NEXT_SIGNING_KEY
	};
}

function parseOcrFeature(
	source: NodeJS.ProcessEnv,
	isProduction: boolean,
	errors: string[]
): OcrFeatureConfig | { status: 'NOT_CONFIGURED' } {
	const group = readFeatureGroup(source, OCR_VARS);
	if (group.present.length === 0) return { status: 'NOT_CONFIGURED' };
	if (group.missing.length > 0) {
		if (isProduction) errors.push(...group.missing);
		return { status: 'NOT_CONFIGURED' };
	}

	return {
		status: 'CONFIGURED',
		apiKey: group.values.GOOGLE_AI_API_KEY,
		meterModel: trim(source.GEMINI_METER_MODEL) || 'gemini-2.5-flash'
	};
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): EnvConfig {
	const nodeEnv = trim(source.NODE_ENV) || 'development';
	const isProduction = nodeEnv === 'production';
	const errors: string[] = [];

	let databaseUrl = trim(source.DATABASE_URL);
	if (!databaseUrl) {
		if (isProduction) errors.push('DATABASE_URL');
		else databaseUrl = DEV_DATABASE_URL;
	} else if (!databaseUrl.startsWith('postgres')) {
		errors.push('DATABASE_URL');
	} else if (isProduction) {
		if (databaseUrlUsesLocalhost(databaseUrl)) errors.push('DATABASE_URL');
		if (databaseUrlHasPlaceholderPassword(databaseUrl)) errors.push('DATABASE_URL');
	}

	let sessionSecret = trim(source.SESSION_SECRET);
	if (!sessionSecret) {
		if (isProduction) errors.push('SESSION_SECRET');
		else sessionSecret = DEV_SESSION_SECRET;
	} else if (isProduction) {
		if (sessionSecret.length < SESSION_SECRET_MIN_LENGTH) errors.push('SESSION_SECRET');
		if (isPlaceholderSessionSecret(sessionSecret)) errors.push('SESSION_SECRET');
	}

	let origin = trim(source.ORIGIN);
	if (!origin) {
		if (isProduction) errors.push('ORIGIN');
		else origin = DEV_ORIGIN;
	}

	let publicAppOrigin = trim(source.PUBLIC_APP_ORIGIN);
	if (!publicAppOrigin) {
		if (isProduction) errors.push('PUBLIC_APP_ORIGIN');
		else publicAppOrigin = trim(source.ORIGIN) || DEV_PUBLIC_APP_ORIGIN;
	}

	const payos = parsePayosFeature(source, isProduction, errors);
	const r2 = parseR2Feature(source, isProduction, errors);
	const telegram = parseTelegramFeature(source, isProduction, errors);
	const qstash = parseQStashFeature(source, isProduction, errors);
	const ocr = parseOcrFeature(source, isProduction, errors);

	if (errors.length > 0) {
		throw new EnvValidationError([...new Set(errors)]);
	}

	return {
		nodeEnv,
		isProduction,
		databaseUrl,
		sessionSecret,
		origin: normalizeOrigin(origin),
		publicAppOrigin: normalizeOrigin(publicAppOrigin),
		cronSecret: trim(source.CRON_SECRET) || null,
		payos,
		r2,
		telegram,
		qstash,
		ocr
	};
}

let cachedEnv: EnvConfig | null = null;

export function getEnv(): EnvConfig {
	if (!cachedEnv) cachedEnv = parseEnv();
	return cachedEnv;
}

export function resetEnvForTests(source?: NodeJS.ProcessEnv) {
	cachedEnv = source ? parseEnv(source) : null;
}

export function validateEnvOrExit(source: NodeJS.ProcessEnv = process.env): EnvConfig {
	try {
		cachedEnv = parseEnv(source);
		return cachedEnv;
	} catch (error) {
		if (error instanceof EnvValidationError) {
			console.error(
				`[env] Boot refused. Missing or invalid variables: ${error.variableNames.join(', ')}`
			);
			process.exit(1);
		}
		throw error;
	}
}

/** API/public origin for machine callbacks (PayOS webhook, etc.). ORIGIN wins over PUBLIC_APP_ORIGIN. */
export function getApiOrigin(): string {
	const env = getEnv();
	return env.origin || env.publicAppOrigin;
}

/** Frontend origin for user-facing redirects after payment. PUBLIC_APP_ORIGIN wins over ORIGIN. */
export function getPublicAppOrigin(): string {
	const env = getEnv();
	return env.publicAppOrigin || env.origin;
}

export function getPayosWebhookUrl(): string {
	return `${getApiOrigin().replace(/\/$/, '')}/api/payos-webhook`;
}

export function isPayosConfigured(): boolean {
	return getEnv().payos.status === 'CONFIGURED';
}

export function isR2Configured(): boolean {
	return getEnv().r2.status === 'CONFIGURED';
}

export function isTelegramConfigured(): boolean {
	return getEnv().telegram.status === 'CONFIGURED';
}

export function isQStashConfigured(): boolean {
	return getEnv().qstash.status === 'CONFIGURED';
}

export function isOcrConfigured(): boolean {
	return getEnv().ocr.status === 'CONFIGURED';
}
