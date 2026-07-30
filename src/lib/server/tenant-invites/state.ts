/**
 * AUTH-009 — tenant invite domain errors and DTOs.
 */

export type TenantInviteErrorCode =
	| 'MANAGED_TENANT_ID_REQUIRED'
	| 'TENANCY_ID_REQUIRED'
	| 'MANAGED_TENANT_NOT_FOUND'
	| 'TENANCY_NOT_FOUND'
	| 'TENANCY_NOT_ACTIVE'
	| 'TENANCY_SCOPE_MISMATCH'
	| 'INVITE_NOT_FOUND'
	| 'INVITE_EXPIRED'
	| 'INVITE_REVOKED'
	| 'INVITE_USED'
	| 'INVITE_STALE_CLAIM_VERSION'
	| 'INVITE_CONFLICT'
	| 'TELEGRAM_ALREADY_LINKED'
	| 'MANAGED_TENANT_ALREADY_CLAIMED'
	| 'IDENTITY_REQUIRED';

const STATUS_BY_CODE: Record<TenantInviteErrorCode, number> = {
	MANAGED_TENANT_ID_REQUIRED: 422,
	TENANCY_ID_REQUIRED: 422,
	MANAGED_TENANT_NOT_FOUND: 404,
	TENANCY_NOT_FOUND: 404,
	TENANCY_NOT_ACTIVE: 409,
	TENANCY_SCOPE_MISMATCH: 404,
	INVITE_NOT_FOUND: 403,
	INVITE_EXPIRED: 403,
	INVITE_REVOKED: 403,
	INVITE_USED: 403,
	INVITE_STALE_CLAIM_VERSION: 409,
	INVITE_CONFLICT: 409,
	TELEGRAM_ALREADY_LINKED: 409,
	MANAGED_TENANT_ALREADY_CLAIMED: 409,
	IDENTITY_REQUIRED: 401
};

const MESSAGE_BY_CODE: Record<TenantInviteErrorCode, string> = {
	MANAGED_TENANT_ID_REQUIRED: 'Thiếu managedTenantId',
	TENANCY_ID_REQUIRED: 'Thiếu tenancyId',
	MANAGED_TENANT_NOT_FOUND: 'Không tìm thấy hồ sơ người thuê',
	TENANCY_NOT_FOUND: 'Không tìm thấy lần thuê',
	TENANCY_NOT_ACTIVE: 'Lần thuê không còn hiệu lực',
	TENANCY_SCOPE_MISMATCH: 'Lần thuê không khớp hồ sơ người thuê',
	INVITE_NOT_FOUND: 'Link mời không hợp lệ hoặc đã hết hạn',
	INVITE_EXPIRED: 'Link mời đã hết hạn',
	INVITE_REVOKED: 'Link mời đã bị thu hồi',
	INVITE_USED: 'Link mời đã được sử dụng',
	INVITE_STALE_CLAIM_VERSION: 'Link mời không còn hiệu lực',
	INVITE_CONFLICT: 'Không thể nhận hồ sơ này',
	TELEGRAM_ALREADY_LINKED: 'Tài khoản Telegram đã liên kết với người dùng khác',
	MANAGED_TENANT_ALREADY_CLAIMED: 'Hồ sơ này đã được liên kết với tài khoản khác',
	IDENTITY_REQUIRED: 'Cần xác minh danh tính trước khi nhận lời mời'
};

export class TenantInviteServiceError extends Error {
	readonly code: TenantInviteErrorCode;
	readonly status: number;

	constructor(code: TenantInviteErrorCode, message?: string) {
		super(message ?? MESSAGE_BY_CODE[code]);
		this.name = 'TenantInviteServiceError';
		this.code = code;
		this.status = STATUS_BY_CODE[code];
	}
}

export function isTenantInviteServiceError(error: unknown): error is TenantInviteServiceError {
	return error instanceof TenantInviteServiceError;
}

export function inviteError(
	code: TenantInviteErrorCode,
	message?: string
): TenantInviteServiceError {
	return new TenantInviteServiceError(code, message);
}

export type IssueTenantInviteInput = {
	managedTenantId: string;
	tenancyId: string;
};

export type IssueTenantInviteResult = {
	token: string;
	link: string | null;
	expiresAt: string;
	inviteId: string;
};

export type AcceptTenantInviteInput = {
	token: string;
	actorUserId: string;
	actorTenantProfileId: string;
	telegramUserId?: string | null;
};

export type AcceptTenantInviteResult = {
	managedTenantId: string;
	tenancyId: string;
	claimedByUserId: string;
	idempotent: boolean;
};

export function toInviteErrorBody(error: TenantInviteServiceError, requestId?: string | null) {
	return {
		error: error.message,
		code: error.code,
		requestId: requestId ?? null
	};
}
