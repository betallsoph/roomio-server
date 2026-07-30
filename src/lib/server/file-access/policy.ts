/**
 * AUTH-011 / DATA-002 — fail-closed file access until TenantFile metadata exists.
 */

export class FileAccessDeniedError extends Error {
	readonly status = 403 as const;

	constructor(message = 'Không có quyền truy cập file') {
		super(message);
		this.name = 'FileAccessDeniedError';
	}
}

export class FileAccessNotFoundError extends Error {
	readonly status = 404 as const;

	constructor(message = 'Không tìm thấy file') {
		super(message);
		this.name = 'FileAccessNotFoundError';
	}
}

export function isFileAccessDeniedError(error: unknown): error is FileAccessDeniedError {
	return error instanceof FileAccessDeniedError;
}

export function isFileAccessNotFoundError(error: unknown): error is FileAccessNotFoundError {
	return error instanceof FileAccessNotFoundError;
}

/** TenantFile schema not production-ready — deny all download/serve by path alone. */
export function assertTenantFileMetadataAvailable(): never {
	throw new FileAccessDeniedError(
		'Truy cập file yêu cầu metadata TenantFile; tính năng chưa sẵn sàng'
	);
}
