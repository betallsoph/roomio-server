import pino, { type Logger, type LoggerOptions } from 'pino';
import { getEnv } from '$lib/server/env';
import { REDACT_PATHS } from './redact.js';
import { resolveRequestId } from './request-id.js';

export { resolveRequestId, isValidRequestId } from './request-id.js';
export { REDACT_PATHS } from './redact.js';
export { LOG_ROTATION_DEFAULTS, LOG_ROTATE_CONFIG_SNIPPET } from './rotation.js';

export function getReleaseSha(): string {
	return (
		process.env.RELEASE_SHA?.trim() ||
		process.env.GITHUB_SHA?.trim() ||
		process.env.COMMIT_SHA?.trim() ||
		'unknown'
	);
}

function resolveLogLevel(): string {
	const fromEnv = process.env.LOG_LEVEL?.trim();
	if (fromEnv) return fromEnv;
	return getEnv().isProduction ? 'info' : 'debug';
}

export function buildLoggerOptions(): LoggerOptions {
	return {
		level: resolveLogLevel(),
		base: {
			service: 'roomio-api',
			environment: getEnv().nodeEnv,
			release: getReleaseSha()
		},
		redact: {
			paths: [...REDACT_PATHS],
			censor: '[REDACTED]'
		},
		formatters: {
			level: (label) => ({ level: label })
		},
		timestamp: pino.stdTimeFunctions.isoTime
	};
}

let rootLogger: Logger | null = null;

export function createLogger(destination?: pino.DestinationStream): Logger {
	return destination ? pino(buildLoggerOptions(), destination) : pino(buildLoggerOptions());
}

export function getLogger(): Logger {
	if (!rootLogger) {
		rootLogger = createLogger();
	}
	return rootLogger;
}

export function resetLoggerForTests(): void {
	rootLogger = null;
}

export function setLoggerForTests(logger: Logger): void {
	rootLogger = logger;
}

export function childRequestLogger(
	requestId: string | null | undefined,
	bindings: Record<string, unknown> = {}
): Logger {
	return getLogger().child({
		requestId: resolveRequestId(requestId),
		...bindings
	});
}

export interface HttpRequestLogFields {
	requestId: string;
	method: string;
	route: string;
	status: number;
	durationMs: number;
}

export function logHttpRequest(fields: HttpRequestLogFields): void {
	const level = fields.status >= 500 ? 'error' : fields.status >= 400 ? 'warn' : 'info';
	getLogger()[level](fields, 'http request');
}

export interface JobLogFields {
	requestId?: string | null;
	jobId?: string;
	jobType: string;
	attempt?: number;
	landlordId?: string;
	outcome: 'started' | 'completed' | 'failed';
	detail?: Record<string, unknown>;
}

export function logJobEvent(fields: JobLogFields): void {
	const logger = fields.requestId
		? childRequestLogger(fields.requestId, { jobType: fields.jobType })
		: getLogger().child({ jobType: fields.jobType });

	const payload = {
		jobId: fields.jobId,
		attempt: fields.attempt,
		landlordId: fields.landlordId,
		outcome: fields.outcome,
		...fields.detail
	};

	if (fields.outcome === 'failed') {
		logger.error(payload, 'job event');
	} else {
		logger.info(payload, 'job event');
	}
}
