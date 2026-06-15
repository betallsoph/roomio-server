// Trả về thông điệp lỗi an toàn cho response API
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unexpected server error';
}
