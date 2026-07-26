import type { SessionData } from '$lib/server/session';

export type LandlordScopeResult = { landlordId: string } | { error: string; status: number };

/**
 * Xác định landlordId cho truy vấn danh sách (GET).
 * Client landlordId không bao giờ là nguồn quyền — chỉ dùng để SUPER_ADMIN chọn phạm vi.
 */
export function resolveLandlordScopeForList(
	session: SessionData | null,
	clientLandlordId: string | null | undefined
): LandlordScopeResult {
	if (!session) {
		return { error: 'Chưa đăng nhập', status: 401 };
	}

	if (session.role === 'LANDLORD') {
		if (!session.landlordProfileId) {
			return { error: 'Không có quyền truy cập', status: 403 };
		}
		if (clientLandlordId && clientLandlordId !== session.landlordProfileId) {
			return { error: 'Không có quyền truy cập dữ liệu này', status: 403 };
		}
		return { landlordId: session.landlordProfileId };
	}

	if (session.role === 'SUPER_ADMIN') {
		if (!clientLandlordId) {
			return { error: 'Thiếu landlordId', status: 400 };
		}
		return { landlordId: clientLandlordId };
	}

	return { error: 'Không có quyền truy cập', status: 403 };
}
