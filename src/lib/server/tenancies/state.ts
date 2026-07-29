/**
 * AUTH-006 — state machine, input normalization và error contract cho "một lần thuê".
 *
 * Module này KHÔNG chạm DB và KHÔNG import schema: chỉ chứa luật thuần để test nhanh
 * không cần PostgreSQL. Mọi truy vấn/transaction nằm ở `./service.ts`.
 *
 * Tham chiếu: docs/production-hardening/01-authorization-tenancy.md §7.3–§7.7 và
 * docs/production-hardening/10-canonical-contracts.md §2, §13.
 */

export const TENANCY_STATUSES = ['ACTIVE', 'ENDED', 'CANCELLED'] as const;
export type TenancyStatus = (typeof TENANCY_STATUSES)[number];

/**
 * Mã lỗi ổn định cho client. Không thêm mã mới mà không cập nhật bảng status bên dưới —
 * endpoint map thẳng sang HTTP nên mã mới thiếu mapping sẽ rơi về 500.
 */
export type TenancyErrorCode =
	// 404 — không tồn tại HOẶC thuộc landlord khác; hai trường hợp trả về giống hệt nhau.
	| 'ROOM_NOT_FOUND'
	| 'MANAGED_TENANT_NOT_FOUND'
	| 'TENANCY_NOT_FOUND'
	| 'PAYMENT_ACCOUNT_NOT_FOUND'
	// 409 — xung đột trạng thái.
	| 'ROOM_OCCUPIED'
	| 'MANAGED_TENANT_ALREADY_ACTIVE'
	| 'MANAGED_TENANT_ARCHIVED'
	| 'TENANCY_NOT_ACTIVE'
	| 'NO_ACTIVE_TENANCY'
	/** Room còn cache người ở nhưng không có Tenancy hợp lệ — fail closed, không ghi đè. */
	| 'ROOM_CACHE_CONFLICT'
	/** Tenancy legacy chưa backfill `managedTenantId` (AUTH-007) — không đoán người thuê. */
	| 'TENANCY_MISSING_MANAGED_TENANT'
	/** ManagedTenant chưa có `legacyTenantProfileId`; KHÔNG bịa TenantProfile để lấp. */
	| 'NO_LEGACY_TENANT_PROFILE'
	/** Body khai `tenantId` khác người thuê thật của lần thuê đang hiệu lực. */
	| 'CONTRACT_TENANT_MISMATCH'
	// 422 — payload sai.
	| 'INVALID_INPUT';

export type TenancyErrorStatus = 404 | 409 | 422;

const TENANCY_ERROR_STATUS: Record<TenancyErrorCode, TenancyErrorStatus> = {
	ROOM_NOT_FOUND: 404,
	MANAGED_TENANT_NOT_FOUND: 404,
	TENANCY_NOT_FOUND: 404,
	PAYMENT_ACCOUNT_NOT_FOUND: 404,
	ROOM_OCCUPIED: 409,
	MANAGED_TENANT_ALREADY_ACTIVE: 409,
	MANAGED_TENANT_ARCHIVED: 409,
	TENANCY_NOT_ACTIVE: 409,
	NO_ACTIVE_TENANCY: 409,
	ROOM_CACHE_CONFLICT: 409,
	TENANCY_MISSING_MANAGED_TENANT: 409,
	NO_LEGACY_TENANT_PROFILE: 409,
	CONTRACT_TENANT_MISMATCH: 409,
	INVALID_INPUT: 422
};

/** Thông báo an toàn: chỉ nói trạng thái nghiệp vụ, không lộ ID hay dữ liệu landlord khác. */
const TENANCY_ERROR_MESSAGE: Record<TenancyErrorCode, string> = {
	ROOM_NOT_FOUND: 'Không tìm thấy phòng',
	MANAGED_TENANT_NOT_FOUND: 'Không tìm thấy hồ sơ người thuê',
	TENANCY_NOT_FOUND: 'Không tìm thấy lần thuê',
	PAYMENT_ACCOUNT_NOT_FOUND: 'Không tìm thấy tài khoản nhận tiền',
	ROOM_OCCUPIED: 'Phòng đang có người thuê',
	MANAGED_TENANT_ALREADY_ACTIVE: 'Hồ sơ người thuê đang có lần thuê hiệu lực',
	MANAGED_TENANT_ARCHIVED: 'Hồ sơ người thuê đã lưu trữ',
	TENANCY_NOT_ACTIVE: 'Lần thuê không còn hiệu lực',
	NO_ACTIVE_TENANCY: 'Phòng không có lần thuê đang hiệu lực',
	ROOM_CACHE_CONFLICT: 'Phòng đang có dữ liệu người ở chưa được đối soát',
	TENANCY_MISSING_MANAGED_TENANT: 'Lần thuê chưa gắn hồ sơ người thuê',
	NO_LEGACY_TENANT_PROFILE: 'Hồ sơ người thuê chưa liên kết dữ liệu hợp đồng cũ',
	CONTRACT_TENANT_MISMATCH: 'Người thuê trong yêu cầu không khớp lần thuê của phòng',
	INVALID_INPUT: 'Dữ liệu không hợp lệ'
};

export class TenancyServiceError extends Error {
	readonly code: TenancyErrorCode;
	readonly status: TenancyErrorStatus;
	/** Chi tiết an toàn cho log nội bộ; KHÔNG trả ra response. */
	readonly detail: string | null;

	constructor(code: TenancyErrorCode, detail?: string, options?: { cause?: unknown }) {
		super(`${code}${detail ? `: ${detail}` : ''}`, options);
		this.name = 'TenancyServiceError';
		this.code = code;
		this.status = TENANCY_ERROR_STATUS[code];
		this.detail = detail ?? null;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export function isTenancyServiceError(error: unknown): error is TenancyServiceError {
	return error instanceof TenancyServiceError;
}

export function tenancyError(code: TenancyErrorCode, detail?: string): TenancyServiceError {
	return new TenancyServiceError(code, detail);
}

/** Body lỗi chuẩn §9.1.7: mã ổn định + thông báo an toàn + request ID. Không kèm detail. */
export function toTenancyErrorBody(
	error: TenancyServiceError,
	requestId?: string | null
): { error: string; code: TenancyErrorCode; requestId?: string } {
	return {
		error: TENANCY_ERROR_MESSAGE[error.code],
		code: error.code,
		...(requestId ? { requestId } : {})
	};
}

// ---------------------------------------------------------------------------
// Ngày theo lịch Việt Nam (canonical §13: không dùng toISOString().slice cho business date)
// ---------------------------------------------------------------------------

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: unknown): value is string {
	if (typeof value !== 'string' || !CALENDAR_DATE_PATTERN.test(value)) return false;
	const [year, month, day] = value.split('-').map(Number);
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	// Chặn 2026-02-31: dựng lại bằng UTC rồi so từng thành phần.
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return (
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
}

const VIETNAM_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Asia/Ho_Chi_Minh',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/** Hôm nay theo lịch Việt Nam, dạng YYYY-MM-DD. */
export function todayInVietnam(now: Date = new Date()): string {
	return VIETNAM_DATE_FORMATTER.format(now);
}

/**
 * Cộng năm trên LỊCH, không qua epoch/timezone: 2028-02-29 + 1 năm = 2029-02-28.
 * Dùng cho hạn hợp đồng mặc định; không dùng `new Date(...).toISOString()` (canonical §13).
 */
export function addYearsToCalendarDate(date: string, years: number): string {
	if (!isCalendarDate(date)) {
		throw tenancyError('INVALID_INPUT', 'date must be YYYY-MM-DD');
	}
	const [year, month, day] = date.split('-').map(Number);
	const targetYear = year + years;
	const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
	const targetDay = Math.min(day, lastDayOfTargetMonth);
	return [
		String(targetYear).padStart(4, '0'),
		String(month).padStart(2, '0'),
		String(targetDay).padStart(2, '0')
	].join('-');
}

// ---------------------------------------------------------------------------
// State machine §7.5
// ---------------------------------------------------------------------------

/** ENDED/CANCELLED là trạng thái cuối: muốn thuê lại thì tạo lần thuê mới. */
export function canEndTenancy(status: string): boolean {
	return status === 'ACTIVE';
}

export function assertCanEndTenancy(status: string): void {
	if (!canEndTenancy(status)) {
		throw tenancyError('TENANCY_NOT_ACTIVE', `status=${status}`);
	}
}

// ---------------------------------------------------------------------------
// Input normalization — service chỉ nhận dữ liệu đã chuẩn hóa
// ---------------------------------------------------------------------------

/** Tiền nhận number hoặc chuỗi số nguyên (body JSON): normalizer là nơi duy nhất ép kiểu. */
export type MoneyInput = number | string | null | undefined;

export type StartTenancyContractInput = {
	endDate: string;
	/** Bỏ trống = lấy `Room.monthlyRent` đã load trong transaction. */
	monthlyRent?: MoneyInput;
	deposit?: MoneyInput;
	fileUrl?: string | null;
	notes?: string | null;
	paymentAccountId?: string | null;
};

export type StartTenancyInput = {
	roomId: string;
	managedTenantId: string;
	/** Bỏ trống = hôm nay theo lịch Việt Nam. */
	startDate?: string | null;
	plannedEndDate?: string | null;
	depositRequired?: MoneyInput;
	contract?: StartTenancyContractInput | null;
};

export type NormalizedStartTenancyContract = {
	endDate: string;
	monthlyRent: number | null;
	deposit: number;
	fileUrl: string | null;
	notes: string | null;
	paymentAccountId: string | null;
};

export type NormalizedStartTenancyInput = {
	roomId: string;
	managedTenantId: string;
	startDate: string;
	plannedEndDate: string | null;
	depositRequired: number;
	contract: NormalizedStartTenancyContract | null;
};

export type EndTenancyInput = {
	tenancyId: string;
	/** Bỏ trống = hôm nay theo lịch Việt Nam. */
	endDate?: string | null;
};

export type NormalizedEndTenancyInput = {
	tenancyId: string;
	endDate: string;
};

function requireId(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw tenancyError('INVALID_INPUT', `${field} is required`);
	}
	return value.trim();
}

function optionalText(value: unknown, field: string, maxLength = 2000): string | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string') {
		throw tenancyError('INVALID_INPUT', `${field} must be a string`);
	}
	if (value.length > maxLength) {
		throw tenancyError('INVALID_INPUT', `${field} exceeds ${maxLength} characters`);
	}
	return value;
}

function requireCalendarDate(value: unknown, field: string): string {
	if (!isCalendarDate(value)) {
		throw tenancyError('INVALID_INPUT', `${field} must be YYYY-MM-DD`);
	}
	return value;
}

/** VND: số nguyên không âm. Không nhận chuỗi rỗng/NaN/float để tránh rác vào cột bigint. */
function nonNegativeAmount(value: unknown, field: string, fallback: number | null = null): number {
	if (value === undefined || value === null || value === '') {
		if (fallback === null) {
			throw tenancyError('INVALID_INPUT', `${field} is required`);
		}
		return fallback;
	}
	const parsed = typeof value === 'string' ? Number(value.trim()) : value;
	if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
		throw tenancyError('INVALID_INPUT', `${field} must be a non-negative number`);
	}
	if (!Number.isSafeInteger(parsed)) {
		throw tenancyError('INVALID_INPUT', `${field} must be an integer amount`);
	}
	return parsed;
}

export function normalizeStartTenancyInput(
	raw: StartTenancyInput,
	now: Date = new Date()
): NormalizedStartTenancyInput {
	const roomId = requireId(raw?.roomId, 'roomId');
	const managedTenantId = requireId(raw?.managedTenantId, 'managedTenantId');

	const startDate =
		raw.startDate === undefined || raw.startDate === null || raw.startDate === ''
			? todayInVietnam(now)
			: requireCalendarDate(raw.startDate, 'startDate');

	const plannedEndDate =
		raw.plannedEndDate === undefined || raw.plannedEndDate === null || raw.plannedEndDate === ''
			? null
			: requireCalendarDate(raw.plannedEndDate, 'plannedEndDate');

	if (plannedEndDate !== null && plannedEndDate < startDate) {
		throw tenancyError('INVALID_INPUT', 'plannedEndDate must be on or after startDate');
	}

	const depositRequired = nonNegativeAmount(raw.depositRequired, 'depositRequired', 0);

	let contract: NormalizedStartTenancyContract | null = null;
	if (raw.contract) {
		const endDate = requireCalendarDate(raw.contract.endDate, 'contract.endDate');
		if (endDate < startDate) {
			throw tenancyError('INVALID_INPUT', 'contract.endDate must be on or after startDate');
		}
		const monthlyRentRaw = raw.contract.monthlyRent;
		contract = {
			endDate,
			monthlyRent:
				monthlyRentRaw === undefined || monthlyRentRaw === null
					? null
					: nonNegativeAmount(monthlyRentRaw, 'contract.monthlyRent'),
			deposit: nonNegativeAmount(raw.contract.deposit, 'contract.deposit', 0),
			fileUrl: optionalText(raw.contract.fileUrl, 'contract.fileUrl', 500),
			notes: optionalText(raw.contract.notes, 'contract.notes'),
			paymentAccountId:
				raw.contract.paymentAccountId === undefined ||
				raw.contract.paymentAccountId === null ||
				raw.contract.paymentAccountId === ''
					? null
					: requireId(raw.contract.paymentAccountId, 'contract.paymentAccountId')
		};
	}

	return { roomId, managedTenantId, startDate, plannedEndDate, depositRequired, contract };
}

export function normalizeEndTenancyInput(
	raw: EndTenancyInput,
	now: Date = new Date()
): NormalizedEndTenancyInput {
	const tenancyId = requireId(raw?.tenancyId, 'tenancyId');
	const endDate =
		raw.endDate === undefined || raw.endDate === null || raw.endDate === ''
			? todayInVietnam(now)
			: requireCalendarDate(raw.endDate, 'endDate');
	return { tenancyId, endDate };
}

/** DB check `Tenancy_ended_end_date_valid` cũng chặn, nhưng báo 422 sớm rõ hơn 500. */
export function assertEndDateNotBeforeStart(endDate: string, startDate: string): void {
	if (endDate < startDate) {
		throw tenancyError('INVALID_INPUT', 'endDate must be on or after startDate');
	}
}

// ---------------------------------------------------------------------------
// Hàng rào cuối: unique partial index cho tenancy ACTIVE (§7.4.5, §7.4.6)
// ---------------------------------------------------------------------------

export const ACTIVE_ROOM_CONSTRAINT = 'Tenancy_active_room_unique';
export const ACTIVE_MANAGED_TENANT_CONSTRAINT = 'Tenancy_active_managedTenant_unique';

const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 5;

type PgLikeError = { code?: unknown; constraint?: unknown; cause?: unknown };

/**
 * Chỉ nhận diện ĐÚNG hai unique index của tenancy ACTIVE. Mọi lỗi DB khác được ném
 * nguyên trạng — không nuốt lỗi hạ tầng thành 409.
 */
export function activeTenancyConflictFromDbError(error: unknown): TenancyServiceError | null {
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current; depth++) {
		const candidate = current as PgLikeError;
		if (candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint === 'string') {
			if (candidate.constraint === ACTIVE_ROOM_CONSTRAINT) {
				return new TenancyServiceError('ROOM_OCCUPIED', 'unique violation', { cause: error });
			}
			if (candidate.constraint === ACTIVE_MANAGED_TENANT_CONSTRAINT) {
				return new TenancyServiceError('MANAGED_TENANT_ALREADY_ACTIVE', 'unique violation', {
					cause: error
				});
			}
			return null;
		}
		current = candidate.cause;
	}
	return null;
}

// ---------------------------------------------------------------------------
// DTO allowlist §9.1 — response chỉ chứa field dưới đây
// ---------------------------------------------------------------------------

export type TenancyRowForDto = {
	id: string;
	landlordId: string;
	propertyId: string;
	roomId: string;
	managedTenantId: string | null;
	status: string;
	startDate: string;
	plannedEndDate: string | null;
	endDate: string | null;
	depositRequired: number;
	createdAt: Date | string;
	updatedAt: Date | string;
};

export type TenancyDto = {
	id: string;
	landlordId: string;
	propertyId: string;
	roomId: string;
	managedTenantId: string | null;
	status: string;
	startDate: string;
	plannedEndDate: string | null;
	endDate: string | null;
	/** VND dạng chuỗi số nguyên theo canonical §4 money type. */
	depositRequired: string;
	createdAt: string;
	updatedAt: string;
};

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toTenancyDto(row: TenancyRowForDto): TenancyDto {
	return {
		id: row.id,
		landlordId: row.landlordId,
		propertyId: row.propertyId,
		roomId: row.roomId,
		managedTenantId: row.managedTenantId,
		status: row.status,
		startDate: row.startDate,
		plannedEndDate: row.plannedEndDate,
		endDate: row.endDate,
		depositRequired: String(row.depositRequired ?? 0),
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt)
	};
}

// ---------------------------------------------------------------------------
// Hợp đồng gắn với một lần thuê
// ---------------------------------------------------------------------------

export type CreateContractInput = {
	roomId: string;
	startDate: string;
	endDate: string;
	/** Bỏ trống = lấy `Room.monthlyRent` đã load trong transaction. */
	monthlyRent?: MoneyInput;
	deposit?: MoneyInput;
	fileUrl?: string | null;
	notes?: string | null;
	paymentAccountId?: string | null;
	/**
	 * `tenantId` client gửi — CHỈ dùng để đối chiếu, không phải authority. Service derive
	 * người thuê thật từ Tenancy ACTIVE + ManagedTenant trong DB; lệch nhau thì từ chối.
	 */
	expectedLegacyTenantProfileId?: string | null;
};

export type NormalizedCreateContractInput = {
	roomId: string;
	startDate: string;
	endDate: string;
	monthlyRent: number | null;
	deposit: number;
	fileUrl: string | null;
	notes: string | null;
	paymentAccountId: string | null;
	expectedLegacyTenantProfileId: string | null;
};

export function normalizeCreateContractInput(
	raw: CreateContractInput
): NormalizedCreateContractInput {
	const roomId = requireId(raw?.roomId, 'roomId');
	const startDate = requireCalendarDate(raw?.startDate, 'startDate');
	const endDate = requireCalendarDate(raw?.endDate, 'endDate');
	if (endDate < startDate) {
		throw tenancyError('INVALID_INPUT', 'endDate must be on or after startDate');
	}

	return {
		roomId,
		startDate,
		endDate,
		monthlyRent:
			raw.monthlyRent === undefined || raw.monthlyRent === null
				? null
				: nonNegativeAmount(raw.monthlyRent, 'monthlyRent'),
		deposit: nonNegativeAmount(raw.deposit, 'deposit', 0),
		fileUrl: optionalText(raw.fileUrl, 'fileUrl', 500),
		notes: optionalText(raw.notes, 'notes'),
		paymentAccountId:
			raw.paymentAccountId === undefined ||
			raw.paymentAccountId === null ||
			raw.paymentAccountId === ''
				? null
				: requireId(raw.paymentAccountId, 'paymentAccountId'),
		expectedLegacyTenantProfileId:
			raw.expectedLegacyTenantProfileId === undefined ||
			raw.expectedLegacyTenantProfileId === null ||
			raw.expectedLegacyTenantProfileId === ''
				? null
				: requireId(raw.expectedLegacyTenantProfileId, 'tenantId')
	};
}

export type ContractRowForDto = {
	id: string;
	tenantId: string;
	roomId: string;
	tenancyId: string | null;
	managedTenantId: string | null;
	startDate: string;
	endDate: string;
	monthlyRent: number;
	deposit: number;
	fileUrl: string | null;
	notes: string | null;
	status: string;
	paymentAccountId: string | null;
	createdAt: Date | string;
};

export type ContractDto = {
	id: string;
	roomId: string;
	tenancyId: string | null;
	managedTenantId: string | null;
	/** ID `TenantProfile` legacy; giữ để client cũ còn chạy trong lúc migrate. */
	tenantId: string;
	startDate: string;
	endDate: string;
	monthlyRent: number;
	deposit: number;
	fileUrl: string | null;
	notes: string | null;
	status: string;
	paymentAccountId: string | null;
	createdAt: string;
};

export function toContractDto(row: ContractRowForDto): ContractDto {
	return {
		id: row.id,
		roomId: row.roomId,
		tenancyId: row.tenancyId,
		managedTenantId: row.managedTenantId,
		tenantId: row.tenantId,
		startDate: row.startDate,
		endDate: row.endDate,
		monthlyRent: row.monthlyRent,
		deposit: row.deposit,
		fileUrl: row.fileUrl,
		notes: row.notes,
		status: row.status,
		paymentAccountId: row.paymentAccountId,
		createdAt: toIso(row.createdAt)
	};
}
