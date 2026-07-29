import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ACTIVE_MANAGED_TENANT_CONSTRAINT,
	ACTIVE_ROOM_CONSTRAINT,
	activeTenancyConflictFromDbError,
	addYearsToCalendarDate,
	assertCanEndTenancy,
	assertEndDateNotBeforeStart,
	canEndTenancy,
	isCalendarDate,
	isTenancyServiceError,
	normalizeCreateContractInput,
	normalizeEndTenancyInput,
	normalizeStartTenancyInput,
	tenancyError,
	todayInVietnam,
	toContractDto,
	toTenancyDto,
	toTenancyErrorBody,
	type ContractDto,
	type TenancyDto
} from './state.js';
import { parseEnv } from '../env.js';

const TENANCY_DTO_KEYS = [
	'id',
	'landlordId',
	'propertyId',
	'roomId',
	'managedTenantId',
	'status',
	'startDate',
	'plannedEndDate',
	'endDate',
	'depositRequired',
	'createdAt',
	'updatedAt'
] as const satisfies readonly (keyof TenancyDto)[];

const CONTRACT_DTO_KEYS = [
	'id',
	'roomId',
	'tenancyId',
	'managedTenantId',
	'tenantId',
	'startDate',
	'endDate',
	'monthlyRent',
	'deposit',
	'fileUrl',
	'notes',
	'status',
	'paymentAccountId',
	'createdAt'
] as const satisfies readonly (keyof ContractDto)[];

function expectTenancyError(fn: () => unknown, code: string, status: number) {
	try {
		fn();
	} catch (error) {
		assert.ok(isTenancyServiceError(error), `expected TenancyServiceError, got ${String(error)}`);
		assert.equal(error.code, code);
		assert.equal(error.status, status);
		return error;
	}
	assert.fail(`expected ${code} to be thrown`);
}

// --- Ngày theo lịch Việt Nam (canonical §13) -------------------------------

test('isCalendarDate rejects malformed and impossible dates', () => {
	assert.equal(isCalendarDate('2026-07-29'), true);
	assert.equal(isCalendarDate('2028-02-29'), true); // năm nhuận
	assert.equal(isCalendarDate('2026-02-31'), false);
	assert.equal(isCalendarDate('2026-13-01'), false);
	assert.equal(isCalendarDate('2026-7-9'), false);
	assert.equal(isCalendarDate('29/07/2026'), false);
	assert.equal(isCalendarDate(20260729), false);
	assert.equal(isCalendarDate(null), false);
});

test('todayInVietnam uses Asia/Ho_Chi_Minh, not UTC', () => {
	// 17:30 UTC ngày 29 = 00:30 ngày 30 giờ Việt Nam.
	assert.equal(todayInVietnam(new Date('2026-07-29T17:30:00.000Z')), '2026-07-30');
	assert.equal(todayInVietnam(new Date('2026-07-29T03:00:00.000Z')), '2026-07-29');
});

test('addYearsToCalendarDate clamps 29 February instead of overflowing', () => {
	assert.equal(addYearsToCalendarDate('2026-01-15', 1), '2027-01-15');
	assert.equal(addYearsToCalendarDate('2028-02-29', 1), '2029-02-28');
	assert.equal(addYearsToCalendarDate('2026-12-31', 1), '2027-12-31');
	expectTenancyError(() => addYearsToCalendarDate('2026-13-01', 1), 'INVALID_INPUT', 422);
});

// --- Chuẩn hóa input ------------------------------------------------------

test('normalizeStartTenancyInput requires room and managed tenant ids', () => {
	expectTenancyError(
		() => normalizeStartTenancyInput({ roomId: '', managedTenantId: 'mt-1' }),
		'INVALID_INPUT',
		422
	);
	expectTenancyError(
		() => normalizeStartTenancyInput({ roomId: 'room-1', managedTenantId: '   ' }),
		'INVALID_INPUT',
		422
	);
});

test('normalizeStartTenancyInput defaults startDate to today in Vietnam', () => {
	const input = normalizeStartTenancyInput(
		{ roomId: 'room-1', managedTenantId: 'mt-1' },
		new Date('2026-07-29T17:30:00.000Z')
	);
	assert.equal(input.startDate, '2026-07-30');
	assert.equal(input.plannedEndDate, null);
	assert.equal(input.depositRequired, 0);
	assert.equal(input.contract, null);
});

test('normalizeStartTenancyInput rejects reversed dates and bad money', () => {
	expectTenancyError(
		() =>
			normalizeStartTenancyInput({
				roomId: 'room-1',
				managedTenantId: 'mt-1',
				startDate: '2026-07-10',
				plannedEndDate: '2026-07-09'
			}),
		'INVALID_INPUT',
		422
	);
	expectTenancyError(
		() =>
			normalizeStartTenancyInput({
				roomId: 'room-1',
				managedTenantId: 'mt-1',
				depositRequired: -1
			}),
		'INVALID_INPUT',
		422
	);
	expectTenancyError(
		() =>
			normalizeStartTenancyInput({
				roomId: 'room-1',
				managedTenantId: 'mt-1',
				depositRequired: 1_500_000.5
			}),
		'INVALID_INPUT',
		422
	);
	expectTenancyError(
		() =>
			normalizeStartTenancyInput({
				roomId: 'room-1',
				managedTenantId: 'mt-1',
				startDate: '2026-07-10',
				contract: { endDate: '2026-07-09' }
			}),
		'INVALID_INPUT',
		422
	);
});

test('normalizeStartTenancyInput keeps contract snapshot fields', () => {
	const input = normalizeStartTenancyInput({
		roomId: ' room-1 ',
		managedTenantId: ' mt-1 ',
		startDate: '2026-07-01',
		depositRequired: '3000000',
		contract: { endDate: '2027-07-01', deposit: 3_000_000, paymentAccountId: 'acc-1' }
	});
	assert.equal(input.roomId, 'room-1');
	assert.equal(input.managedTenantId, 'mt-1');
	assert.equal(input.depositRequired, 3_000_000);
	assert.equal(input.contract?.endDate, '2027-07-01');
	assert.equal(input.contract?.monthlyRent, null); // lấy từ Room trong transaction
	assert.equal(input.contract?.paymentAccountId, 'acc-1');
});

test('normalizeEndTenancyInput defaults endDate and requires tenancyId', () => {
	const input = normalizeEndTenancyInput(
		{ tenancyId: 'tenancy-1' },
		new Date('2026-07-29T17:30:00.000Z')
	);
	assert.equal(input.endDate, '2026-07-30');
	expectTenancyError(() => normalizeEndTenancyInput({ tenancyId: '' }), 'INVALID_INPUT', 422);
	expectTenancyError(
		() => normalizeEndTenancyInput({ tenancyId: 'tenancy-1', endDate: '2026-02-31' }),
		'INVALID_INPUT',
		422
	);
});

test('assertEndDateNotBeforeStart mirrors the Tenancy_ended_end_date_valid check', () => {
	assert.doesNotThrow(() => assertEndDateNotBeforeStart('2026-07-10', '2026-07-10'));
	expectTenancyError(
		() => assertEndDateNotBeforeStart('2026-07-09', '2026-07-10'),
		'INVALID_INPUT',
		422
	);
});

// --- State machine §7.5 ---------------------------------------------------

test('only ACTIVE tenancies can be ended', () => {
	assert.equal(canEndTenancy('ACTIVE'), true);
	assert.equal(canEndTenancy('ENDED'), false);
	assert.equal(canEndTenancy('CANCELLED'), false);
	expectTenancyError(() => assertCanEndTenancy('ENDED'), 'TENANCY_NOT_ACTIVE', 409);
	expectTenancyError(() => assertCanEndTenancy('CANCELLED'), 'TENANCY_NOT_ACTIVE', 409);
});

// --- Hàng rào cuối: unique partial index ----------------------------------

test('activeTenancyConflictFromDbError maps only the two ACTIVE tenancy constraints', () => {
	const roomConflict = activeTenancyConflictFromDbError({
		code: '23505',
		constraint: ACTIVE_ROOM_CONSTRAINT
	});
	assert.equal(roomConflict?.code, 'ROOM_OCCUPIED');
	assert.equal(roomConflict?.status, 409);

	const managedTenantConflict = activeTenancyConflictFromDbError({
		code: '23505',
		constraint: ACTIVE_MANAGED_TENANT_CONSTRAINT
	});
	assert.equal(managedTenantConflict?.code, 'MANAGED_TENANT_ALREADY_ACTIVE');

	// Drizzle bọc lỗi driver: phải đi theo chuỗi cause.
	const wrapped = activeTenancyConflictFromDbError({
		message: 'query failed',
		cause: { code: '23505', constraint: ACTIVE_ROOM_CONSTRAINT }
	});
	assert.equal(wrapped?.code, 'ROOM_OCCUPIED');
});

test('activeTenancyConflictFromDbError does not swallow other database errors', () => {
	assert.equal(
		activeTenancyConflictFromDbError({ code: '23505', constraint: 'User_email_unique' }),
		null
	);
	assert.equal(activeTenancyConflictFromDbError({ code: '23503' }), null);
	assert.equal(activeTenancyConflictFromDbError(new Error('connection terminated')), null);
	assert.equal(activeTenancyConflictFromDbError(null), null);
});

// --- DTO và error body ----------------------------------------------------

test('toTenancyDto exposes only the allowlist and money as an integer string', () => {
	const dto = toTenancyDto({
		id: 'tenancy-1',
		landlordId: 'landlord-1',
		propertyId: 'property-1',
		roomId: 'room-1',
		managedTenantId: 'mt-1',
		status: 'ACTIVE',
		startDate: '2026-07-01',
		plannedEndDate: null,
		endDate: null,
		depositRequired: 3_000_000,
		createdAt: new Date('2026-07-01T00:00:00.000Z'),
		updatedAt: new Date('2026-07-01T00:00:00.000Z')
	});

	assert.deepEqual(Object.keys(dto).sort(), [...TENANCY_DTO_KEYS].sort());
	assert.equal(dto.depositRequired, '3000000');
	assert.equal(dto.createdAt, '2026-07-01T00:00:00.000Z');
	assert.equal('endedByUserId' in dto, false);
	assert.equal('createdByUserId' in dto, false);
	assert.equal('needsReview' in dto, false);
});

test('toTenancyErrorBody returns a stable code without leaking internal detail', () => {
	const error = expectTenancyError(() => assertCanEndTenancy('ENDED'), 'TENANCY_NOT_ACTIVE', 409);
	const body = toTenancyErrorBody(error, 'req-1');
	assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'requestId']);
	assert.equal(body.code, 'TENANCY_NOT_ACTIVE');
	assert.equal(body.requestId, 'req-1');
	assert.equal(body.error.includes('status='), false);
	assert.equal(JSON.stringify(body).includes('ENDED'), false);
});

// --- Contract gắn lần thuê ------------------------------------------------

test('normalizeCreateContractInput validates dates and money', () => {
	const input = normalizeCreateContractInput({
		roomId: ' room-1 ',
		startDate: '2026-07-01',
		endDate: '2027-07-01',
		deposit: '3000000',
		expectedLegacyTenantProfileId: ' profile-1 '
	});
	assert.equal(input.roomId, 'room-1');
	assert.equal(input.deposit, 3_000_000);
	assert.equal(input.monthlyRent, null); // lấy từ Room trong transaction
	assert.equal(input.expectedLegacyTenantProfileId, 'profile-1');

	// tenantId trống = client không khai gì để đối chiếu, không phải lỗi.
	assert.equal(
		normalizeCreateContractInput({
			roomId: 'room-1',
			startDate: '2026-07-01',
			endDate: '2027-07-01'
		}).expectedLegacyTenantProfileId,
		null
	);

	expectTenancyError(
		() =>
			normalizeCreateContractInput({
				roomId: 'room-1',
				startDate: '2026-07-02',
				endDate: '2026-07-01'
			}),
		'INVALID_INPUT',
		422
	);
	expectTenancyError(
		() =>
			normalizeCreateContractInput({ roomId: '', startDate: '2026-07-01', endDate: '2027-07-01' }),
		'INVALID_INPUT',
		422
	);
});

test('toContractDto exposes the tenancy snapshot and no raw row spread', () => {
	const dto = toContractDto({
		id: 'contract-1',
		tenantId: 'profile-1',
		roomId: 'room-1',
		tenancyId: 'tenancy-1',
		managedTenantId: 'mt-1',
		startDate: '2026-07-01',
		endDate: '2027-07-01',
		monthlyRent: 3_000_000,
		deposit: 3_000_000,
		fileUrl: null,
		notes: null,
		status: 'active',
		paymentAccountId: 'acc-1',
		createdAt: new Date('2026-07-01T00:00:00.000Z')
	});

	assert.deepEqual(Object.keys(dto).sort(), [...CONTRACT_DTO_KEYS].sort());
	assert.equal(dto.tenancyId, 'tenancy-1');
	assert.equal(dto.managedTenantId, 'mt-1');
	assert.equal(dto.createdAt, '2026-07-01T00:00:00.000Z');
});

test('state conflicts introduced by the review all map to 409', () => {
	for (const code of [
		'ROOM_CACHE_CONFLICT',
		'TENANCY_MISSING_MANAGED_TENANT',
		'NO_LEGACY_TENANT_PROFILE',
		'CONTRACT_TENANT_MISMATCH'
	] as const) {
		const error = tenancyError(code, 'internal detail');
		assert.equal(error.status, 409, `${code} must be a 409 state conflict`);

		const body = toTenancyErrorBody(error, 'req-1');
		assert.equal(body.code, code);
		assert.equal(
			JSON.stringify(body).includes('internal detail'),
			false,
			'error body must not leak internal detail'
		);
	}
});

// --- Feature flag AUTH-006 ------------------------------------------------

const BASE_ENV: NodeJS.ProcessEnv = {
	NODE_ENV: 'test',
	DATABASE_URL: 'postgres://appuser:S3cure-Str1ng-For-Unit-Tests@db.internal:5432/roomio',
	SESSION_SECRET: 'unit-test-session-secret-32-chars-min!!',
	ORIGIN: 'https://api.test.invalid',
	PUBLIC_APP_ORIGIN: 'https://app.test.invalid'
};

test('TENANCY_DUAL_WRITE_ENABLED defaults to false when unset', () => {
	assert.equal(parseEnv({ ...BASE_ENV }).tenancyDualWriteEnabled, false);
	assert.equal(
		parseEnv({ ...BASE_ENV, TENANCY_DUAL_WRITE_ENABLED: '' }).tenancyDualWriteEnabled,
		false
	);
});

test('TENANCY_DUAL_WRITE_ENABLED defaults to false in production when unset', () => {
	const productionEnv = {
		...BASE_ENV,
		NODE_ENV: 'production',
		SUPER_ADMIN_ACCOUNTS: 'owner@roomio.invalid:a-long-production-owner-passphrase'
	};
	assert.equal(parseEnv(productionEnv).tenancyDualWriteEnabled, false);
});

test('TENANCY_DUAL_WRITE_ENABLED accepts explicit booleans and rejects garbage', () => {
	for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
		assert.equal(
			parseEnv({ ...BASE_ENV, TENANCY_DUAL_WRITE_ENABLED: value }).tenancyDualWriteEnabled,
			true,
			`expected ${value} to enable the flag`
		);
	}
	for (const value of ['false', '0', 'no', 'off']) {
		assert.equal(
			parseEnv({ ...BASE_ENV, TENANCY_DUAL_WRITE_ENABLED: value }).tenancyDualWriteEnabled,
			false,
			`expected ${value} to disable the flag`
		);
	}
	// Giá trị lạ phải chặn boot thay vì âm thầm tắt/bật.
	assert.throws(
		() => parseEnv({ ...BASE_ENV, TENANCY_DUAL_WRITE_ENABLED: 'maybe' }),
		/TENANCY_DUAL_WRITE_ENABLED/
	);
});
