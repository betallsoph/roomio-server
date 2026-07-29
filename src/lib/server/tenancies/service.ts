/**
 * AUTH-006 — service duy nhất để BẮT ĐẦU và KẾT THÚC một lần thuê.
 *
 * Luật nền (01-authorization-tenancy.md §4.4, §7.6, §7.7):
 * - Chỉ nhận `LandlordActor` đã xác minh từ `locals.actor`; KHÔNG đọc `locals.session`.
 * - Input KHÔNG mang `landlordId`: scope snapshot luôn derive từ room → property trong DB.
 * - `ManagedTenant.claimedByUserId` được phép null — invite/User/Telegram không phải
 *   dependency của `startTenancy` (§7.6 "chốt thứ tự canonical").
 * - `Room.currentManagedTenantId`/`Room.tenantId` chỉ là CACHE tương thích; lịch sử có
 *   thẩm quyền nằm ở `Tenancy`. Không bao giờ đọc cache để cấp quyền.
 * - Không tạo `User`/`TenantProfile` để lấp dữ liệu legacy (đó là việc của AUTH-009).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '$lib/server/db/schema';
import {
	contracts,
	managedTenants,
	paymentAccounts,
	properties,
	rooms,
	tenancies,
	tenantInvites
} from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import { appendAudit, auditActorFromUserActor, type AuditTx } from '$lib/server/audit';
import { childRequestLogger } from '$lib/server/logger';
import {
	activeTenancyConflictFromDbError,
	assertCanEndTenancy,
	assertEndDateNotBeforeStart,
	normalizeCreateContractInput,
	normalizeEndTenancyInput,
	normalizeStartTenancyInput,
	tenancyError,
	toContractDto,
	toTenancyDto,
	type ContractDto,
	type CreateContractInput,
	type EndTenancyInput,
	type StartTenancyInput,
	type TenancyDto
} from './state.js';

export type TenancyDb = NodePgDatabase<typeof schema>;
export type TenancyTx = AuditTx;
/** Nhận `db` hoặc một transaction đang mở; tx lồng nhau tạo SAVEPOINT nên rollback vẫn đúng. */
export type TenancyConn = TenancyDb | TenancyTx;

export type TenancyServiceOptions = {
	/** Request ID để nối audit/log; không phải nguồn phân quyền. */
	requestId?: string | null;
	/** Cho phép test tiêm thời điểm; mặc định là now. */
	now?: Date;
};

export type ContractLinkResult = {
	created: boolean;
	id: string | null;
	/**
	 * `Contract.tenantId` vẫn NOT NULL FK tới `TenantProfile` (schema 0023). Khi ManagedTenant
	 * chưa có `legacyTenantProfileId`, service KHÔNG bịa TenantProfile — nó bỏ qua contract và
	 * báo lý do ra ngoài. Siết cột này là việc của AUTH-019.
	 */
	skippedReason: 'NO_LEGACY_TENANT_PROFILE' | null;
};

export type StartTenancyResult = {
	tenancy: TenancyDto;
	contract: ContractLinkResult;
	/** true khi đã dual-write `Room.tenantId` legacy vì ManagedTenant có legacy profile. */
	legacyRoomTenantWritten: boolean;
};

export type EndTenancyResult = {
	tenancy: TenancyDto;
	/** false khi cache đã trỏ người thuê khác (race) — không được xóa nhầm người mới. */
	roomCacheCleared: boolean;
	legacyRoomTenantCleared: boolean;
	pendingInvitesRevoked: number;
};

/**
 * `db.transaction` và `tx.transaction` cùng chữ ký nhưng TypeScript không hợp nhất được
 * union; ép kiểu một lần tại đây thay vì rải khắp service.
 */
function runInTransaction<T>(conn: TenancyConn, fn: (tx: TenancyTx) => Promise<T>): Promise<T> {
	return (conn as TenancyDb).transaction(fn);
}

function serviceLogger(requestId?: string | null) {
	return childRequestLogger(requestId, { component: 'tenancies' });
}

/**
 * OBS: chỉ ID/cờ boolean. Không log tên, email, phone, ảnh, body, token hay DB URL.
 */
function logScopeGap(
	requestId: string | null | undefined,
	metric: 'tenancy_row_missing_managed_tenant' | 'tenancy_room_cache_conflict',
	fields: Record<string, string | boolean | null>
): void {
	serviceLogger(requestId).warn({ metric, ...fields }, 'tenancy scope gap');
}

type LoadedRoomScope = {
	roomId: string;
	propertyId: string;
	landlordId: string;
	monthlyRent: number;
	currentManagedTenantId: string | null;
	legacyTenantId: string | null;
};

/**
 * Load room + property và CHỨNG MINH `property.landlordId === actor.landlordId`.
 * Room không tồn tại và room của landlord khác trả về cùng một lỗi 404 (§4.3).
 */
async function loadRoomScopeForUpdate(
	tx: TenancyTx,
	actor: LandlordActor,
	roomId: string
): Promise<LoadedRoomScope> {
	const roomRows = await tx
		.select({
			id: rooms.id,
			propertyId: rooms.propertyId,
			monthlyRent: rooms.monthlyRent,
			currentManagedTenantId: rooms.currentManagedTenantId,
			tenantId: rooms.tenantId
		})
		.from(rooms)
		.where(eq(rooms.id, roomId))
		.for('update')
		.limit(1);

	const room = roomRows[0];
	if (!room) throw tenancyError('ROOM_NOT_FOUND', 'room row missing');

	const propertyRows = await tx
		.select({ id: properties.id, landlordId: properties.landlordId })
		.from(properties)
		.where(and(eq(properties.id, room.propertyId), eq(properties.landlordId, actor.landlordId)))
		.limit(1);

	const property = propertyRows[0];
	if (!property) throw tenancyError('ROOM_NOT_FOUND', 'property out of actor scope');

	return {
		roomId: room.id,
		propertyId: property.id,
		landlordId: property.landlordId,
		monthlyRent: room.monthlyRent,
		currentManagedTenantId: room.currentManagedTenantId,
		legacyTenantId: room.tenantId
	};
}

type LoadedManagedTenant = {
	id: string;
	status: string;
	legacyTenantProfileId: string | null;
	claimed: boolean;
};

async function loadManagedTenantForUpdate(
	tx: TenancyTx,
	actor: LandlordActor,
	managedTenantId: string
): Promise<LoadedManagedTenant> {
	const rows = await tx
		.select({
			id: managedTenants.id,
			status: managedTenants.status,
			legacyTenantProfileId: managedTenants.legacyTenantProfileId,
			claimedByUserId: managedTenants.claimedByUserId
		})
		.from(managedTenants)
		.where(
			and(eq(managedTenants.id, managedTenantId), eq(managedTenants.landlordId, actor.landlordId))
		)
		.for('update')
		.limit(1);

	const row = rows[0];
	// Không tồn tại và thuộc landlord khác đều là 404: không xác nhận sự tồn tại cross-scope.
	if (!row) throw tenancyError('MANAGED_TENANT_NOT_FOUND', 'managed tenant out of actor scope');
	if (row.status === 'ARCHIVED') {
		throw tenancyError('MANAGED_TENANT_ARCHIVED', 'managed tenant archived');
	}

	// claimedByUserId null là HỢP LỆ: landlord được cho thuê trước, invite sau.
	return {
		id: row.id,
		status: row.status,
		legacyTenantProfileId: row.legacyTenantProfileId,
		claimed: row.claimedByUserId !== null
	};
}

async function assertNoActiveTenancyForRoom(tx: TenancyTx, roomId: string): Promise<void> {
	const rows = await tx
		.select({ id: tenancies.id })
		.from(tenancies)
		.where(and(eq(tenancies.roomId, roomId), eq(tenancies.status, 'ACTIVE')))
		.limit(1);
	if (rows.length > 0) throw tenancyError('ROOM_OCCUPIED', 'active tenancy exists for room');
}

async function assertNoActiveTenancyForManagedTenant(
	tx: TenancyTx,
	managedTenantId: string
): Promise<void> {
	const rows = await tx
		.select({ id: tenancies.id })
		.from(tenancies)
		.where(and(eq(tenancies.managedTenantId, managedTenantId), eq(tenancies.status, 'ACTIVE')))
		.limit(1);
	if (rows.length > 0) {
		throw tenancyError('MANAGED_TENANT_ALREADY_ACTIVE', 'active tenancy exists for managed tenant');
	}
}

async function assertPaymentAccountInScope(
	tx: TenancyTx,
	actor: LandlordActor,
	paymentAccountId: string
): Promise<void> {
	const rows = await tx
		.select({ id: paymentAccounts.id })
		.from(paymentAccounts)
		.where(
			and(
				eq(paymentAccounts.id, paymentAccountId),
				eq(paymentAccounts.landlordId, actor.landlordId)
			)
		)
		.limit(1);
	if (rows.length === 0) {
		throw tenancyError('PAYMENT_ACCOUNT_NOT_FOUND', 'payment account out of actor scope');
	}
}

/**
 * §7.6 — bắt đầu một lần thuê trong MỘT transaction. Bất kỳ bước nào fail (kể cả contract
 * hoặc append audit) thì rollback toàn bộ: không có tenancy mồ côi, không có cache lệch.
 */
export async function startTenancy(
	conn: TenancyConn,
	actor: LandlordActor,
	rawInput: StartTenancyInput,
	options: TenancyServiceOptions = {}
): Promise<StartTenancyResult> {
	const input = normalizeStartTenancyInput(rawInput, options.now ?? new Date());
	const requestId = options.requestId ?? null;

	const result = await runInTransaction(conn, async (tx) => {
		const room = await loadRoomScopeForUpdate(tx, actor, input.roomId);
		const managedTenant = await loadManagedTenantForUpdate(tx, actor, input.managedTenantId);

		await assertNoActiveTenancyForRoom(tx, room.roomId);
		// Không có Tenancy ACTIVE mà cache vẫn còn người ở = dữ liệu legacy chưa đối soát
		// (AUTH-007) hoặc lệch do sự cố. FAIL CLOSED: không ghi đè occupant cũ.
		if (room.currentManagedTenantId !== null || room.legacyTenantId !== null) {
			throw tenancyError('ROOM_CACHE_CONFLICT', 'room occupant cache without active tenancy');
		}
		await assertNoActiveTenancyForManagedTenant(tx, managedTenant.id);

		if (input.contract?.paymentAccountId) {
			await assertPaymentAccountInScope(tx, actor, input.contract.paymentAccountId);
		}

		// Snapshot scope lấy TỪ DB, không từ body.
		let insertedTenancy;
		try {
			const inserted = await tx
				.insert(tenancies)
				.values({
					landlordId: room.landlordId,
					propertyId: room.propertyId,
					roomId: room.roomId,
					// Bắt buộc có giá trị với mọi row mới dù DDL còn nullable cho backfill legacy.
					managedTenantId: managedTenant.id,
					status: 'ACTIVE',
					startDate: input.startDate,
					plannedEndDate: input.plannedEndDate,
					depositRequired: input.depositRequired,
					createdByActorType: 'USER',
					createdByUserId: actor.userId
				})
				.returning();
			insertedTenancy = inserted[0];
		} catch (error) {
			// Hàng rào cuối cho race: chỉ ĐÚNG hai unique index ACTIVE mới thành 409.
			const conflict = activeTenancyConflictFromDbError(error);
			if (conflict) throw conflict;
			throw error;
		}

		if (!insertedTenancy) throw new Error('startTenancy insert did not return a row');

		// Dual-write CACHE tương thích. `Room.tenantId` legacy chỉ ghi khi ManagedTenant có
		// legacy profile — tuyệt đối không tạo TenantProfile giả để lấp chỗ trống.
		const legacyRoomTenantWritten = managedTenant.legacyTenantProfileId !== null;
		await tx
			.update(rooms)
			.set({
				currentManagedTenantId: managedTenant.id,
				// Ghi tường minh: không có legacy profile thì cache legacy phải là null,
				// tránh giữ lại người ở cũ trong cột này.
				tenantId: managedTenant.legacyTenantProfileId ?? null
			})
			.where(eq(rooms.id, room.roomId));

		const contract: ContractLinkResult = { created: false, id: null, skippedReason: null };
		if (input.contract) {
			if (!managedTenant.legacyTenantProfileId) {
				contract.skippedReason = 'NO_LEGACY_TENANT_PROFILE';
			} else {
				const insertedContract = await tx
					.insert(contracts)
					.values({
						tenantId: managedTenant.legacyTenantProfileId,
						roomId: room.roomId,
						startDate: insertedTenancy.startDate,
						endDate: input.contract.endDate,
						monthlyRent: input.contract.monthlyRent ?? room.monthlyRent,
						deposit: input.contract.deposit,
						fileUrl: input.contract.fileUrl,
						notes: input.contract.notes,
						paymentAccountId: input.contract.paymentAccountId,
						status: 'active',
						// Snapshot lấy từ tenancy vừa tạo trong cùng transaction, không từ query param.
						managedTenantId: managedTenant.id,
						tenancyId: insertedTenancy.id
					})
					.returning({ id: contracts.id });
				contract.created = true;
				contract.id = insertedContract[0]?.id ?? null;
			}
		}

		// Audit nằm TRONG transaction: audit fail thì tenancy/contract/cache cùng rollback.
		await appendAudit(tx, auditActorFromUserActor(actor, room.landlordId), {
			action: 'TENANCY.CREATED',
			resourceType: 'Tenancy',
			resourceId: insertedTenancy.id,
			landlordId: room.landlordId,
			requestId,
			scope: 'LANDLORD',
			metadata: {
				roomId: room.roomId,
				propertyId: room.propertyId,
				managedTenantId: managedTenant.id,
				startDate: insertedTenancy.startDate,
				managedTenantClaimed: managedTenant.claimed,
				legacyRoomTenantWritten,
				contractCreated: contract.created,
				...(contract.skippedReason ? { contractSkippedReason: contract.skippedReason } : {})
			}
		});

		return {
			tenancy: toTenancyDto(insertedTenancy),
			contract,
			legacyRoomTenantWritten
		} satisfies StartTenancyResult;
	});

	if (result.contract.skippedReason) {
		logScopeGap(requestId, 'tenancy_row_missing_managed_tenant', {
			resource: 'Contract',
			tenancyId: result.tenancy.id,
			reason: result.contract.skippedReason
		});
	}

	return result;
}

/**
 * §7.7 — kết thúc lần thuê. Contract đã chốt: end lần hai trả 409 `TENANCY_NOT_ACTIVE`
 * (không im lặng thành công), vì caller cần biết mình vừa thao tác trên state cũ.
 */
export async function endTenancy(
	conn: TenancyConn,
	actor: LandlordActor,
	rawInput: EndTenancyInput,
	options: TenancyServiceOptions = {}
): Promise<EndTenancyResult> {
	const input = normalizeEndTenancyInput(rawInput, options.now ?? new Date());
	const requestId = options.requestId ?? null;

	const result = await runInTransaction(conn, async (tx) => {
		// Scope bằng tenancy.id + actor.landlordId — không đi vòng qua Room cache.
		const rows = await tx
			.select({
				id: tenancies.id,
				landlordId: tenancies.landlordId,
				propertyId: tenancies.propertyId,
				roomId: tenancies.roomId,
				managedTenantId: tenancies.managedTenantId,
				status: tenancies.status,
				startDate: tenancies.startDate
			})
			.from(tenancies)
			.where(and(eq(tenancies.id, input.tenancyId), eq(tenancies.landlordId, actor.landlordId)))
			.for('update')
			.limit(1);

		const tenancy = rows[0];
		if (!tenancy) throw tenancyError('TENANCY_NOT_FOUND', 'tenancy out of actor scope');

		assertCanEndTenancy(tenancy.status);
		assertEndDateNotBeforeStart(input.endDate, tenancy.startDate);

		// Conditional update: chỉ ACTIVE mới chuyển được sang ENDED.
		const updated = await tx
			.update(tenancies)
			.set({
				status: 'ENDED',
				endDate: input.endDate,
				endedByUserId: actor.userId
			})
			.where(and(eq(tenancies.id, tenancy.id), eq(tenancies.status, 'ACTIVE')))
			.returning();

		const endedTenancy = updated[0];
		if (!endedTenancy)
			throw tenancyError('TENANCY_NOT_ACTIVE', 'conditional update matched 0 rows');

		let roomCacheCleared = false;
		let legacyRoomTenantCleared = false;

		if (tenancy.managedTenantId) {
			// CHỈ clear khi cache vẫn trỏ đúng người của tenancy này — race với check-in mới
			// không được xóa occupant mới.
			const clearedRooms = await tx
				.update(rooms)
				.set({ currentManagedTenantId: null })
				.where(
					and(
						eq(rooms.id, tenancy.roomId),
						eq(rooms.currentManagedTenantId, tenancy.managedTenantId)
					)
				)
				.returning({ id: rooms.id });
			roomCacheCleared = clearedRooms.length > 0;

			const managedTenantRows = await tx
				.select({ legacyTenantProfileId: managedTenants.legacyTenantProfileId })
				.from(managedTenants)
				.where(
					and(
						eq(managedTenants.id, tenancy.managedTenantId),
						eq(managedTenants.landlordId, actor.landlordId)
					)
				)
				.limit(1);

			const legacyTenantProfileId = managedTenantRows[0]?.legacyTenantProfileId ?? null;
			if (legacyTenantProfileId) {
				const clearedLegacy = await tx
					.update(rooms)
					.set({ tenantId: null })
					.where(and(eq(rooms.id, tenancy.roomId), eq(rooms.tenantId, legacyTenantProfileId)))
					.returning({ id: rooms.id });
				legacyRoomTenantCleared = clearedLegacy.length > 0;
			}
		}

		// §7.7.7 — invite pending gắn tenancy này không được accept sau khi đã end.
		const revokedInvites = await tx
			.update(tenantInvites)
			.set({ status: 'REVOKED', revokedAt: options.now ?? new Date() })
			.where(and(eq(tenantInvites.tenancyId, tenancy.id), eq(tenantInvites.status, 'PENDING')))
			.returning({ id: tenantInvites.id });

		await appendAudit(tx, auditActorFromUserActor(actor, tenancy.landlordId), {
			action: 'TENANCY.TERMINATED',
			resourceType: 'Tenancy',
			resourceId: tenancy.id,
			landlordId: tenancy.landlordId,
			requestId,
			scope: 'LANDLORD',
			metadata: {
				roomId: tenancy.roomId,
				propertyId: tenancy.propertyId,
				managedTenantId: tenancy.managedTenantId,
				endDate: input.endDate,
				roomCacheCleared,
				legacyRoomTenantCleared,
				pendingInvitesRevoked: revokedInvites.length
			}
		});

		return {
			tenancy: toTenancyDto(endedTenancy),
			roomCacheCleared,
			legacyRoomTenantCleared,
			pendingInvitesRevoked: revokedInvites.length,
			hadManagedTenant: tenancy.managedTenantId !== null
		};
	});

	if (!result.hadManagedTenant) {
		// Row legacy chưa backfill (AUTH-007): không đủ scope để dọn cache an toàn.
		logScopeGap(requestId, 'tenancy_row_missing_managed_tenant', {
			resource: 'Tenancy',
			tenancyId: result.tenancy.id,
			reason: null
		});
	} else if (!result.roomCacheCleared) {
		// Cache đã thuộc về người thuê khác — đúng theo thiết kế, nhưng cần đo.
		logScopeGap(requestId, 'tenancy_room_cache_conflict', {
			resource: 'Room',
			tenancyId: result.tenancy.id,
			reason: null
		});
	}

	return {
		tenancy: result.tenancy,
		roomCacheCleared: result.roomCacheCleared,
		legacyRoomTenantCleared: result.legacyRoomTenantCleared,
		pendingInvitesRevoked: result.pendingInvitesRevoked
	};
}

/**
 * Adapter cho endpoint checkout theo phòng: resolve tenancy ACTIVE trong scope actor rồi
 * gọi `endTenancy`. Room ngoài scope trả 404, phòng trống trả 409.
 */
export async function endActiveTenancyForRoom(
	conn: TenancyConn,
	actor: LandlordActor,
	input: { roomId: string; endDate?: string | null },
	options: TenancyServiceOptions = {}
): Promise<EndTenancyResult> {
	return runInTransaction(conn, async (tx) => {
		const room = await loadRoomScopeForUpdate(tx, actor, input.roomId);

		const rows = await tx
			.select({ id: tenancies.id })
			.from(tenancies)
			.where(
				and(
					eq(tenancies.roomId, room.roomId),
					eq(tenancies.landlordId, actor.landlordId),
					eq(tenancies.status, 'ACTIVE')
				)
			)
			.limit(1);

		const tenancyId = rows[0]?.id;
		if (!tenancyId) throw tenancyError('NO_ACTIVE_TENANCY', 'no active tenancy for room');

		return endTenancy(tx, actor, { tenancyId, endDate: input.endDate }, options);
	});
}

/**
 * Tạo hợp đồng gắn ĐÚNG lần thuê đang hiệu lực của phòng, trong MỘT transaction.
 *
 * Chống race với checkout: `SELECT … FOR UPDATE` giữ row tenancy tới khi commit. Nếu
 * checkout thắng trước, điều kiện `status = 'ACTIVE'` được đánh giá lại sau khi lấy được
 * lock nên tenancy đã ENDED không còn khớp và lệnh này trả 409 thay vì gắn nhầm.
 *
 * Mọi ID người thuê (`tenancyId`, `managedTenantId`, `tenantId` legacy) đều derive từ DB.
 * `tenantId` client gửi chỉ để đối chiếu.
 */
export async function createContractForActiveTenancy(
	conn: TenancyConn,
	actor: LandlordActor,
	rawInput: CreateContractInput
): Promise<ContractDto> {
	const input = normalizeCreateContractInput(rawInput);

	return runInTransaction(conn, async (tx) => {
		const room = await loadRoomScopeForUpdate(tx, actor, input.roomId);

		const tenancyRows = await tx
			.select({
				id: tenancies.id,
				managedTenantId: tenancies.managedTenantId,
				startDate: tenancies.startDate
			})
			.from(tenancies)
			.where(
				and(
					eq(tenancies.roomId, room.roomId),
					eq(tenancies.landlordId, actor.landlordId),
					eq(tenancies.status, 'ACTIVE')
				)
			)
			.for('update')
			.limit(1);

		const tenancy = tenancyRows[0];
		// Không có lần thuê hiệu lực thì KHÔNG tạo contract mồ côi với snapshot null.
		if (!tenancy) throw tenancyError('NO_ACTIVE_TENANCY', 'no active tenancy for room');
		if (!tenancy.managedTenantId) {
			throw tenancyError('TENANCY_MISSING_MANAGED_TENANT', 'legacy tenancy pending backfill');
		}

		const managedTenant = await loadManagedTenantForUpdate(tx, actor, tenancy.managedTenantId);
		if (!managedTenant.legacyTenantProfileId) {
			throw tenancyError('NO_LEGACY_TENANT_PROFILE', 'managed tenant has no legacy profile');
		}
		// Body khai người thuê khác người thuê thật của lần thuê này → từ chối, không im lặng.
		if (
			input.expectedLegacyTenantProfileId &&
			input.expectedLegacyTenantProfileId !== managedTenant.legacyTenantProfileId
		) {
			throw tenancyError('CONTRACT_TENANT_MISMATCH', 'body tenantId is not the room occupant');
		}

		if (input.paymentAccountId) {
			await assertPaymentAccountInScope(tx, actor, input.paymentAccountId);
		}

		const inserted = await tx
			.insert(contracts)
			.values({
				tenantId: managedTenant.legacyTenantProfileId,
				roomId: room.roomId,
				startDate: input.startDate,
				endDate: input.endDate,
				monthlyRent: input.monthlyRent ?? room.monthlyRent,
				deposit: input.deposit,
				fileUrl: input.fileUrl,
				notes: input.notes,
				paymentAccountId: input.paymentAccountId,
				status: 'active',
				managedTenantId: managedTenant.id,
				tenancyId: tenancy.id
			})
			.returning();

		const contract = inserted[0];
		if (!contract) throw new Error('createContractForActiveTenancy did not return a row');
		return toContractDto(contract);
	});
}

/**
 * Guard chống split-brain khi flag bị tắt lại: luồng legacy không được thêm người ở mới
 * vào phòng đã có Tenancy ACTIVE. Chỉ trả boolean, không cấp quyền.
 */
export async function hasActiveTenancyForRoom(conn: TenancyDb, roomId: string): Promise<boolean> {
	const rows = await conn
		.select({ id: tenancies.id })
		.from(tenancies)
		.where(and(eq(tenancies.roomId, roomId), eq(tenancies.status, 'ACTIVE')))
		.limit(1);
	return rows.length > 0;
}

/**
 * OBS metric AUTH-006.9 — đếm row mới thiếu tenancy/scope để phát hiện endpoint chưa migrate.
 * Chỉ trả về số đếm, không kèm dữ liệu người thuê.
 */
export async function countRowsMissingTenancyScope(
	conn: TenancyDb,
	landlordId: string
): Promise<{ tenanciesMissingManagedTenant: number; contractsMissingTenancy: number }> {
	const tenancyRows = await conn
		.select({ count: sql<number>`count(*)::int` })
		.from(tenancies)
		.where(and(eq(tenancies.landlordId, landlordId), isNull(tenancies.managedTenantId)));

	const contractRows = await conn
		.select({ count: sql<number>`count(*)::int` })
		.from(contracts)
		.innerJoin(rooms, eq(contracts.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(properties.landlordId, landlordId), isNull(contracts.tenancyId)));

	return {
		tenanciesMissingManagedTenant: tenancyRows[0]?.count ?? 0,
		contractsMissingTenancy: contractRows[0]?.count ?? 0
	};
}
