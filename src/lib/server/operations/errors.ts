export class OperationsError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'OperationsError';
		this.status = status;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export function isOperationsError(error: unknown): error is OperationsError {
	return error instanceof OperationsError;
}

export function operationsNotFound(message = 'Không tìm thấy'): OperationsError {
	return new OperationsError(message, 404);
}

export function operationsForbidden(
	message = 'Không có quyền truy cập dữ liệu này'
): OperationsError {
	return new OperationsError(message, 403);
}

export function operationsConflict(message: string): OperationsError {
	return new OperationsError(message, 409);
}

export function operationsValidation(message: string): OperationsError {
	return new OperationsError(message, 422);
}
