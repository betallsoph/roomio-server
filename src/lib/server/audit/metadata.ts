import { AUDIT_ACTION_VERSION } from './actions.js';

export const AUDIT_METADATA_MAX_BYTES = 4096;
export const AUDIT_METADATA_MAX_DEPTH = 2;
export const AUDIT_METADATA_MAX_KEYS = 20;
export const AUDIT_METADATA_MAX_STRING_LENGTH = 256;

export type AuditValidationErrorCode =
	| 'UNSUPPORTED_METADATA_VERSION'
	| 'INVALID_METADATA'
	| 'FORBIDDEN_METADATA_KEY'
	| 'METADATA_TOO_DEEP'
	| 'METADATA_TOO_MANY_KEYS'
	| 'METADATA_TOO_LARGE'
	| 'INVALID_METADATA_VALUE'
	| 'INVALID_ACTION'
	| 'INVALID_SCOPE'
	| 'MISSING_ACTOR_USER_ID'
	| 'MISSING_LANDLORD_ID'
	| 'INVALID_RESOURCE'
	| 'INVALID_CURSOR';

const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
	'password',
	'token',
	'cookie',
	'authorization',
	'secret',
	'ciphertext',
	'body',
	'raw',
	'content',
	'message',
	'email',
	'phone',
	'filename',
	'url',
	'signed',
	'initdata',
	'image',
	'file',
	'customfield',
	'contact'
];

export class AuditValidationError extends Error {
	readonly code: AuditValidationErrorCode;

	constructor(code: AuditValidationErrorCode, message: string) {
		super(message);
		this.name = 'AuditValidationError';
		this.code = code;
	}
}

export function isAuditValidationError(error: unknown): error is AuditValidationError {
	return error instanceof AuditValidationError;
}

function isForbiddenMetadataKey(key: string): boolean {
	const lower = key.toLowerCase();
	return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function assertMetadataSize(value: Record<string, unknown>): void {
	const serialized = JSON.stringify(value);
	if (serialized.length > AUDIT_METADATA_MAX_BYTES) {
		throw new AuditValidationError(
			'METADATA_TOO_LARGE',
			`Audit metadata exceeds ${AUDIT_METADATA_MAX_BYTES} bytes after validation`
		);
	}
}

function validateMetadataString(value: string): string {
	if (value.length > AUDIT_METADATA_MAX_STRING_LENGTH) {
		throw new AuditValidationError(
			'INVALID_METADATA_VALUE',
			`Audit metadata string exceeds ${AUDIT_METADATA_MAX_STRING_LENGTH} characters`
		);
	}
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) < 32) {
			throw new AuditValidationError(
				'INVALID_METADATA_VALUE',
				'Audit metadata string contains control characters'
			);
		}
	}
	return value;
}

function validateMetadataValue(value: unknown, depth: number): unknown {
	if (value === null) return null;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new AuditValidationError(
				'INVALID_METADATA_VALUE',
				'Audit metadata number must be finite'
			);
		}
		return value;
	}
	if (typeof value === 'string') {
		return validateMetadataString(value);
	}
	if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
		throw new AuditValidationError(
			'INVALID_METADATA_VALUE',
			'Audit metadata value type is not allowed'
		);
	}
	if (Array.isArray(value)) {
		if (depth > AUDIT_METADATA_MAX_DEPTH) {
			throw new AuditValidationError('METADATA_TOO_DEEP', 'Audit metadata exceeds maximum depth');
		}
		return value.map((entry) => validateMetadataValue(entry, depth + 1));
	}
	if (typeof value === 'object') {
		return validateMetadataObject(value as Record<string, unknown>, depth + 1);
	}
	throw new AuditValidationError(
		'INVALID_METADATA_VALUE',
		'Audit metadata value type is not allowed'
	);
}

function validateMetadataObject(
	input: Record<string, unknown>,
	depth: number
): Record<string, unknown> {
	if (depth > AUDIT_METADATA_MAX_DEPTH) {
		throw new AuditValidationError('METADATA_TOO_DEEP', 'Audit metadata exceeds maximum depth');
	}

	const keys = Object.keys(input);
	if (keys.length > AUDIT_METADATA_MAX_KEYS) {
		throw new AuditValidationError(
			'METADATA_TOO_MANY_KEYS',
			`Audit metadata object exceeds ${AUDIT_METADATA_MAX_KEYS} keys`
		);
	}

	const output: Record<string, unknown> = {};
	for (const key of keys) {
		if (isForbiddenMetadataKey(key)) {
			throw new AuditValidationError(
				'FORBIDDEN_METADATA_KEY',
				`Audit metadata key "${key}" is forbidden`
			);
		}
		output[key] = validateMetadataValue(input[key], depth);
	}
	return output;
}

export function validateAuditMetadata(input: unknown, version: number): Record<string, unknown> {
	if (version !== AUDIT_ACTION_VERSION) {
		throw new AuditValidationError(
			'UNSUPPORTED_METADATA_VERSION',
			`Unsupported audit metadata version ${version}`
		);
	}

	if (input === undefined || input === null) {
		return {};
	}
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw new AuditValidationError('INVALID_METADATA', 'Audit metadata must be a plain object');
	}

	const validated = validateMetadataObject(input as Record<string, unknown>, 0);
	assertMetadataSize(validated);
	return validated;
}
