/**
 * AUTH-009 — managed tenant domain errors and contact normalization.
 * Contact snapshots are operational data only; never used to find or link Users.
 */

export type ManagedTenantErrorCode =
	| 'DISPLAY_NAME_REQUIRED'
	| 'MANAGED_TENANT_NOT_FOUND'
	| 'MANAGED_TENANT_ARCHIVED';

export class ManagedTenantServiceError extends Error {
	readonly code: ManagedTenantErrorCode;
	readonly status: number;

	constructor(code: ManagedTenantErrorCode, message: string, status: number) {
		super(message);
		this.name = 'ManagedTenantServiceError';
		this.code = code;
		this.status = status;
	}
}

export function isManagedTenantServiceError(error: unknown): error is ManagedTenantServiceError {
	return error instanceof ManagedTenantServiceError;
}

export function managedTenantError(
	code: ManagedTenantErrorCode,
	message: string
): ManagedTenantServiceError {
	const status =
		code === 'MANAGED_TENANT_NOT_FOUND' ? 404 : code === 'DISPLAY_NAME_REQUIRED' ? 422 : 409;
	return new ManagedTenantServiceError(code, message, status);
}

export type CreateManagedTenantInput = {
	displayName: string;
	email?: string | null;
	phone?: string | null;
};

export type ManagedTenantRow = {
	id: string;
	landlordId: string;
	displayName: string;
	emailSnapshot: string | null;
	phoneSnapshot: string | null;
	claimedByUserId: string | null;
	claimVersion: number;
	status: string;
	createdAt: Date;
};

export type ManagedTenantSummaryDto = {
	/** ManagedTenant.id — API compatibility name `tenantId` refers to this value. */
	id: string;
	tenantId: string;
	displayName: string;
	emailSnapshot: string | null;
	phoneSnapshot: string | null;
	isClaimed: boolean;
	createdAt: string;
};

/** Trim/lowercase email for snapshot storage; never used to match Users. */
export function normalizeEmailSnapshot(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : null;
}

/** Normalize phone snapshot for display/search; never used to match Users. */
export function normalizePhoneSnapshot(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const digits = value.replace(/\D/g, '');
	if (digits.length === 0) return null;
	if (digits.startsWith('84') && digits.length >= 11) return `+${digits}`;
	if (digits.startsWith('0')) return digits;
	return digits;
}

export function normalizeCreateManagedTenantInput(raw: unknown): CreateManagedTenantInput {
	const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
	if (!displayName) throw managedTenantError('DISPLAY_NAME_REQUIRED', 'Thiếu tên người thuê');
	return {
		displayName,
		email: normalizeEmailSnapshot(body.email),
		phone: normalizePhoneSnapshot(body.phone)
	};
}

export function toManagedTenantSummaryDto(row: ManagedTenantRow): ManagedTenantSummaryDto {
	return {
		id: row.id,
		tenantId: row.id,
		displayName: row.displayName,
		emailSnapshot: row.emailSnapshot,
		phoneSnapshot: row.phoneSnapshot,
		isClaimed: row.claimedByUserId !== null,
		createdAt: row.createdAt.toISOString()
	};
}
