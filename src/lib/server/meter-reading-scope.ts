import type { SessionData } from '$lib/server/session';

// AUTH-013 emergency containment (P0, tạm thời trước khi có Tenancy schema).
//
// GET /api/meter-readings trước đây lấy landlordId/tenantId TỪ QUERY và bỏ qua actor,
// nên bất kỳ phiên nào cũng đọc được chỉ số/ảnh đồng hồ/thông tin phòng ngoài phạm vi.
// Helper này quyết định phạm vi ĐỌC dựa DUY NHẤT trên actor trong session, không tin ID client.
//
// Nguyên tắc:
// - Scope của LANDLORD/STAFF luôn lấy từ session, ID client không mở rộng quyền.
// - TENANT bị khóa lịch sử cho tới khi có Tenancy: lọc theo "phòng đang ở" vẫn lộ chỉ số
//   của khách cũ cùng phòng, nên trả 403 thay vì lọc sai.
// - SUPER_ADMIN phải chỉ định landlord rõ ràng; thiếu thì 400, không trả toàn hệ thống.

export const TENANCY_HISTORY_NOT_READY = 'TENANCY_HISTORY_NOT_READY';

export type MeterReadingScopeQuery = {
	landlordId?: string | null;
	tenantId?: string | null;
};

export type MeterReadingScopeDecision =
	| { ok: true; landlordId: string }
	| { ok: false; status: number; error: string; code?: string };

/**
 * Quyết định phạm vi landlord cho GET meter readings từ actor đã xác thực.
 * Không truy vấn database và không phụ thuộc ID do client gửi để cấp quyền.
 */
export function resolveMeterReadingScope(
	session: SessionData | null,
	query: MeterReadingScopeQuery = {}
): MeterReadingScopeDecision {
	if (!session) {
		return { ok: false, status: 401, error: 'Chưa đăng nhập' };
	}

	switch (session.role) {
		case 'LANDLORD': {
			// Scope cố định theo landlord của phiên; query landlordId/tenantId bị bỏ qua.
			const landlordId = session.landlordProfileId;
			if (!landlordId) {
				return { ok: false, status: 403, error: 'Phiên chủ trọ không hợp lệ' };
			}
			return { ok: true, landlordId };
		}

		case 'STAFF': {
			// Nhân viên chỉ trong phạm vi chủ trọ mình phục vụ; không cross-landlord.
			const landlordId = session.staffLandlordId;
			if (!landlordId) {
				return { ok: false, status: 403, error: 'Nhân viên chưa được gán chủ trọ' };
			}
			return { ok: true, landlordId };
		}

		case 'TENANT':
			// Tạm khóa lịch sử: lọc theo phòng hiện tại vẫn lộ chỉ số khách cũ.
			return {
				ok: false,
				status: 403,
				error: 'Lịch sử chỉ số theo lần thuê chưa sẵn sàng',
				code: TENANCY_HISTORY_NOT_READY
			};

		case 'SUPER_ADMIN': {
			// Bắt buộc chỉ định landlord rõ ràng; thiếu thì 400, tránh trả toàn hệ thống.
			const explicit = query.landlordId?.trim();
			if (!explicit) {
				return {
					ok: false,
					status: 400,
					error: 'Super admin phải chỉ định landlordId để giới hạn phạm vi'
				};
			}
			return { ok: true, landlordId: explicit };
		}

		default:
			// Default deny cho vai trò không xác định.
			return { ok: false, status: 403, error: 'Không có quyền truy cập dữ liệu này' };
	}
}
