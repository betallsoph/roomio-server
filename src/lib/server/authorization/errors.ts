import { json } from '@sveltejs/kit';

export type AuthorizationStatus = 401 | 403;

export type AuthorizationErrorCode =
	| 'UNAUTHENTICATED'
	| 'SESSION_EXPIRED'
	| 'ROLE_CHANGED'
	| 'FORBIDDEN'
	| 'WRONG_ROLE'
	| 'WRONG_ACTOR_KIND';

export class AuthorizationError extends Error {
	readonly status: AuthorizationStatus;
	readonly code: AuthorizationErrorCode;

	constructor(
		message: string,
		options: { status: AuthorizationStatus; code: AuthorizationErrorCode; cause?: unknown }
	) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'AuthorizationError';
		this.status = options.status;
		this.code = options.code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** 401 revoke signal for getUserActor / hooks (AUTH-002). */
export class UnauthorizedError extends AuthorizationError {
	constructor(message = 'Phiên đã hết hiệu lực, vui lòng đăng nhập lại') {
		super(message, { status: 401, code: 'SESSION_EXPIRED' });
		this.name = 'UnauthorizedError';
	}
}

export function isAuthorizationError(error: unknown): error is AuthorizationError {
	return error instanceof AuthorizationError;
}

export function unauthenticatedError(message = 'Chưa đăng nhập'): AuthorizationError {
	return new AuthorizationError(message, { status: 401, code: 'UNAUTHENTICATED' });
}

export function sessionExpiredError(
	message = 'Phiên đã hết hiệu lực, vui lòng đăng nhập lại'
): AuthorizationError {
	return new AuthorizationError(message, { status: 401, code: 'SESSION_EXPIRED' });
}

export function roleChangedError(
	message = 'Quyền truy cập đã thay đổi, vui lòng đăng nhập lại'
): AuthorizationError {
	return new AuthorizationError(message, { status: 401, code: 'ROLE_CHANGED' });
}

export function forbiddenError(
	message = 'Không có quyền truy cập dữ liệu này'
): AuthorizationError {
	return new AuthorizationError(message, { status: 403, code: 'FORBIDDEN' });
}

export function wrongRoleError(message: string): AuthorizationError {
	return new AuthorizationError(message, { status: 403, code: 'WRONG_ROLE' });
}

export function wrongActorKindError(
	message = 'Chỉ tài khoản người dùng được phép truy cập'
): AuthorizationError {
	return new AuthorizationError(message, { status: 403, code: 'WRONG_ACTOR_KIND' });
}

export function authorizationErrorToResponse(error: AuthorizationError): Response {
	return json({ error: error.message }, { status: error.status });
}
