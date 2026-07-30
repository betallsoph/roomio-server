import crypto from 'node:crypto';
import type { MachineActor, MachineChannel } from './actor.js';

/** Constant-time string compare for shared secrets and webhook tokens. */
export function timingSafeEqualString(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

export function verifySharedSecret(provided: string | null | undefined, expected: string): boolean {
	if (!provided) return false;
	return timingSafeEqualString(provided, expected);
}

export function verifyTelegramWebhookSecret(
	headerValue: string | null,
	expectedSecret: string
): boolean {
	return verifySharedSecret(headerValue, expectedSecret);
}

export function verifyCronSecret(headerValue: string | null, expectedSecret: string): boolean {
	return verifySharedSecret(headerValue, expectedSecret);
}

export function createMachineActor(
	channel: MachineChannel,
	requestId: string,
	options?: { verifiedAccountId?: string }
): MachineActor {
	return {
		kind: 'MACHINE',
		channel,
		requestId,
		...(options?.verifiedAccountId ? { verifiedAccountId: options.verifiedAccountId } : {})
	};
}

export type PayOSWebhookPayload = {
	code?: string;
	desc?: string;
	success?: boolean;
	data: Record<string, unknown>;
	signature: string;
};

/** Minimal structural parse — no business writes; signature still unverified. */
export function parsePayOSWebhookBody(body: unknown): PayOSWebhookPayload | null {
	if (!body || typeof body !== 'object') return null;
	const record = body as Record<string, unknown>;
	const data = record.data;
	const signature = record.signature;
	if (!data || typeof data !== 'object' || signature === undefined || signature === null) {
		return null;
	}
	return {
		code: record.code !== undefined ? String(record.code) : undefined,
		desc: record.desc !== undefined ? String(record.desc) : undefined,
		success: record.success === true,
		data: data as Record<string, unknown>,
		signature: String(signature)
	};
}

export function extractPayOSOrderIdentifiers(data: Record<string, unknown>) {
	const orderCode = data.orderCode !== undefined ? String(data.orderCode) : null;
	const paymentLinkId = data.paymentLinkId ? String(data.paymentLinkId) : null;
	const amount = Number(data.amount) || 0;
	const providerTransactionId = String(
		data.reference ??
			`${orderCode ?? 'unknown'}:${paymentLinkId ?? 'unknown'}:${data.transactionDateTime ?? ''}:${amount}`
	);
	return { orderCode, paymentLinkId, amount, providerTransactionId };
}

export type MachineVerificationLog = {
	warn: (fields: Record<string, unknown>, message?: string) => void;
	info?: (fields: Record<string, unknown>, message?: string) => void;
};

export function logMachineVerificationFailure(
	log: MachineVerificationLog,
	requestId: string,
	channel: MachineChannel,
	reason: string,
	detail: Record<string, unknown> = {}
): void {
	log.warn(
		{
			requestId,
			channel,
			outcome: 'verification_failed',
			reason,
			...detail
		},
		'machine route verification failed'
	);
}

/** Strip raw webhook bodies and provider payloads from error/log detail objects. */
export function redactMachineDetail(detail: Record<string, unknown>): Record<string, unknown> {
	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(detail)) {
		const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
		if (
			normalized.includes('rawpayload') ||
			normalized.includes('body') ||
			normalized.includes('secret') ||
			normalized.includes('signature') ||
			normalized.includes('token') ||
			normalized.includes('checksum')
		) {
			redacted[key] = '[REDACTED]';
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}
