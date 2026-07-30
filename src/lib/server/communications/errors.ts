import type { db as AppDb } from '$lib/server/db';

export type CommunicationsDb = Pick<
	typeof AppDb,
	'query' | 'select' | 'insert' | 'update' | 'delete'
>;

export class CommunicationsError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'CommunicationsError';
		this.status = status;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export function isCommunicationsError(error: unknown): error is CommunicationsError {
	return error instanceof CommunicationsError;
}

export function communicationsNotFound(message = 'Không tìm thấy'): CommunicationsError {
	return new CommunicationsError(message, 404);
}

export function communicationsForbidden(
	message = 'Không có quyền truy cập dữ liệu này'
): CommunicationsError {
	return new CommunicationsError(message, 403);
}

export function communicationsValidation(message: string): CommunicationsError {
	return new CommunicationsError(message, 422);
}
