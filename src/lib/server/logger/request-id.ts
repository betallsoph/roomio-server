import { randomUUID } from 'node:crypto';

/** Accept external IDs only when they look like opaque correlation tokens (8–64 chars). */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidRequestId(value: string | null | undefined): value is string {
	if (!value) return false;
	const trimmed = value.trim();
	return trimmed.length >= 8 && trimmed.length <= 64 && REQUEST_ID_PATTERN.test(trimmed);
}

export function resolveRequestId(incoming: string | null | undefined): string {
	if (isValidRequestId(incoming)) {
		return incoming.trim();
	}
	return randomUUID();
}
