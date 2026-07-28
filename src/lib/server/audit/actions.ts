/**
 * CORE-006 — versioned audit action allowlist (Lane 1 catalog).
 */

export const AUDIT_ACTION_VERSION = 1 as const;

export const AUDIT_ACTIONS = [
	'AUTH.LOGIN_SUCCESS',
	'CONFIG.UPDATED',
	'JOB.COMPLETED',
	'PAYMENT.RECORDED',
	'PLATFORM.BACKFILL_EXECUTED'
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
	return (AUDIT_ACTIONS as readonly string[]).includes(value);
}
