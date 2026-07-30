import { and, desc, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import {
	contracts,
	invoices,
	managedTenants,
	paymentAccounts,
	properties,
	rooms,
	tenancies
} from '$lib/server/db/schema';
import type { LandlordActor, TenantActor } from '$lib/server/authorization/actor';
import {
	findContractForLandlord,
	findInvoiceForLandlord,
	findInvoiceForTenantHistory,
	findPaymentAccountForLandlord,
	ScopedResourceNotFoundError
} from '$lib/server/authorization/scoped-queries';
import { listClaimedTenancyScopesForTenant } from './active-tenancy.js';
import { isOperationsError, operationsNotFound, operationsValidation } from './errors.js';

type FinanceDb = Pick<typeof AppDb, 'query' | 'select'>;

export type FinanceListFilters = {
	status?: string | null;
	roomId?: string | null;
	tenantProfileId?: string | null;
	month?: string | null;
};

export type TenancySnapshot = {
	managedTenantId: string;
	tenancyId: string;
};

const invoiceWithRelations = {
	items: true,
	paymentAccount: true,
	room: {
		with: {
			property: true,
			block: true
		}
	}
} as const;

const contractWithRelations = {
	tenant: { with: { user: { columns: { name: true, phone: true } } } },
	paymentAccount: true,
	room: {
		with: {
			property: { columns: { name: true, shortName: true } },
			paymentAccount: true
		}
	}
} as const;

/** Landlord-owned room ids — shared by invoice/contract/bulk finance lanes. */
export function landlordRoomIdsSubquery(database: FinanceDb, landlordId: string) {
	return database
		.select({ id: rooms.id })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(eq(properties.landlordId, landlordId));
}

function tenantSnapshotOrConditions(scopes: TenancySnapshot[]): SQL | undefined {
	if (scopes.length === 0) {
		return undefined;
	}
	const parts = scopes.map((scope) =>
		and(
			eq(invoices.managedTenantId, scope.managedTenantId),
			eq(invoices.tenancyId, scope.tenancyId)
		)
	);
	return or(...parts)!;
}

function contractTenantSnapshotOrConditions(scopes: TenancySnapshot[]): SQL | undefined {
	if (scopes.length === 0) {
		return undefined;
	}
	const parts = scopes.map((scope) =>
		and(
			eq(contracts.managedTenantId, scope.managedTenantId),
			eq(contracts.tenancyId, scope.tenancyId)
		)
	);
	return or(...parts)!;
}

export async function resolveActiveTenancySnapshotForRoom(
	database: FinanceDb,
	landlordId: string,
	roomId: string
): Promise<TenancySnapshot | null> {
	const row = await database.query.tenancies.findFirst({
		where: and(
			eq(tenancies.roomId, roomId),
			eq(tenancies.landlordId, landlordId),
			eq(tenancies.status, 'ACTIVE')
		),
		columns: { id: true, managedTenantId: true }
	});
	if (!row?.managedTenantId) {
		return null;
	}
	return { managedTenantId: row.managedTenantId, tenancyId: row.id };
}

export async function assertPaymentAccountForLandlordRoom(
	database: FinanceDb,
	landlordId: string,
	roomId: string,
	paymentAccountId: string
): Promise<void> {
	const roomRows = await database
		.select({ landlordId: properties.landlordId })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(rooms.id, roomId), eq(properties.landlordId, landlordId)))
		.limit(1);
	if (!roomRows[0]) {
		throw operationsNotFound();
	}

	const account = await database.query.paymentAccounts.findFirst({
		where: and(
			eq(paymentAccounts.id, paymentAccountId),
			eq(paymentAccounts.landlordId, landlordId)
		),
		columns: { id: true, landlordId: true }
	});
	if (!account || account.landlordId !== roomRows[0].landlordId) {
		throw operationsNotFound('Tài khoản nhận tiền không thuộc chủ trọ của phòng này');
	}
}

/**
 * Bulk input: every room id must belong to the landlord-owned property; unique count must match.
 */
export async function validateScopedRoomIdsForProperty(
	database: FinanceDb,
	actor: LandlordActor,
	propertyId: string,
	roomIds: string[]
): Promise<void> {
	if (roomIds.length === 0) {
		return;
	}
	const uniqueIds = [...new Set(roomIds.map(String))];
	const scoped = await database
		.select({ id: rooms.id })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(
			and(
				eq(properties.id, propertyId),
				eq(properties.landlordId, actor.landlordId),
				inArray(rooms.id, uniqueIds)
			)
		);
	if (scoped.length !== uniqueIds.length) {
		throw operationsNotFound('Một hoặc nhiều phòng không tồn tại hoặc không thuộc tòa nhà này');
	}
}

export async function listInvoicesForLandlord(
	database: FinanceDb,
	actor: LandlordActor,
	filters: FinanceListFilters = {}
) {
	const conditions: SQL[] = [
		inArray(invoices.roomId, landlordRoomIdsSubquery(database, actor.landlordId))
	];

	if (filters.status) {
		conditions.push(eq(invoices.status, filters.status));
	} else {
		conditions.push(ne(invoices.status, 'draft'));
	}
	if (filters.roomId) {
		conditions.push(eq(invoices.roomId, filters.roomId));
	}
	if (filters.month) {
		conditions.push(eq(invoices.month, filters.month));
	}
	if (filters.tenantProfileId) {
		const managedTenantIds = database
			.select({ id: managedTenants.id })
			.from(managedTenants)
			.where(
				and(
					eq(managedTenants.landlordId, actor.landlordId),
					eq(managedTenants.legacyTenantProfileId, filters.tenantProfileId)
				)
			);
		const legacyRoomIds = database
			.select({ id: rooms.id })
			.from(rooms)
			.innerJoin(properties, eq(rooms.propertyId, properties.id))
			.where(
				and(
					eq(properties.landlordId, actor.landlordId),
					eq(rooms.tenantId, filters.tenantProfileId)
				)
			);
		conditions.push(
			or(
				inArray(invoices.managedTenantId, managedTenantIds),
				and(isNull(invoices.tenancyId), inArray(invoices.roomId, legacyRoomIds))
			)!
		);
	}

	return database.query.invoices.findMany({
		where: and(...conditions),
		with: invoiceWithRelations,
		orderBy: [desc(invoices.month), desc(invoices.createdAt)]
	});
}

export async function listInvoicesForTenant(database: FinanceDb, actor: TenantActor) {
	const scopes = await listClaimedTenancyScopesForTenant(database, actor);
	const snapshotWhere = tenantSnapshotOrConditions(scopes);
	if (!snapshotWhere) {
		return [];
	}

	return database.query.invoices.findMany({
		where: and(snapshotWhere, ne(invoices.status, 'draft')),
		with: invoiceWithRelations,
		orderBy: [desc(invoices.month), desc(invoices.createdAt)]
	});
}

export async function getInvoiceForLandlord(
	database: FinanceDb,
	actor: LandlordActor,
	invoiceId: string
) {
	await findInvoiceForLandlord(database, actor, invoiceId);
	return database.query.invoices.findFirst({
		where: eq(invoices.id, invoiceId),
		with: {
			items: true,
			paymentAccount: true,
			room: {
				with: {
					property: { with: { landlord: true } }
				}
			}
		}
	});
}

export async function getInvoiceForTenant(
	database: FinanceDb,
	actor: TenantActor,
	invoiceId: string
) {
	const probe = await database.query.invoices.findFirst({
		where: eq(invoices.id, invoiceId),
		columns: { managedTenantId: true, tenancyId: true }
	});
	if (!probe?.managedTenantId || !probe.tenancyId) {
		throw new ScopedResourceNotFoundError();
	}
	await findInvoiceForTenantHistory(
		database,
		actor,
		{
			managedTenantId: probe.managedTenantId,
			tenancyId: probe.tenancyId
		},
		invoiceId
	);
	return database.query.invoices.findFirst({
		where: eq(invoices.id, invoiceId),
		with: {
			items: true,
			paymentAccount: true,
			room: {
				with: {
					property: { with: { landlord: true } }
				}
			}
		}
	});
}

export async function listContractsForLandlord(
	database: FinanceDb,
	actor: LandlordActor,
	filters: { tenantProfileId?: string | null } = {}
) {
	const conditions: SQL[] = [
		inArray(contracts.roomId, landlordRoomIdsSubquery(database, actor.landlordId))
	];
	if (filters.tenantProfileId) {
		const managedTenantIds = database
			.select({ id: managedTenants.id })
			.from(managedTenants)
			.where(
				and(
					eq(managedTenants.landlordId, actor.landlordId),
					eq(managedTenants.legacyTenantProfileId, filters.tenantProfileId)
				)
			);
		conditions.push(
			or(
				inArray(contracts.managedTenantId, managedTenantIds),
				and(isNull(contracts.tenancyId), eq(contracts.tenantId, filters.tenantProfileId))
			)!
		);
	}

	return database.query.contracts.findMany({
		where: and(...conditions),
		with: contractWithRelations,
		orderBy: desc(contracts.createdAt)
	});
}

export async function listContractsForTenant(database: FinanceDb, actor: TenantActor) {
	const scopes = await listClaimedTenancyScopesForTenant(database, actor);
	const snapshotWhere = contractTenantSnapshotOrConditions(scopes);
	if (!snapshotWhere) {
		return [];
	}

	return database.query.contracts.findMany({
		where: snapshotWhere,
		with: contractWithRelations,
		orderBy: desc(contracts.createdAt)
	});
}

export async function getContractForLandlord(
	database: FinanceDb,
	actor: LandlordActor,
	contractId: string
) {
	await findContractForLandlord(database, actor, contractId);
	return database.query.contracts.findFirst({
		where: eq(contracts.id, contractId),
		with: contractWithRelations
	});
}

export async function listDraftInvoiceIdsForLandlord(
	database: FinanceDb,
	actor: LandlordActor,
	input: { ids?: string[]; propertyId?: string | null; month?: string | null }
): Promise<Array<{ id: string; roomId: string; totalAmount: number; month: string }>> {
	const landlordRoomIds = landlordRoomIdsSubquery(database, actor.landlordId);
	const conditions: SQL[] = [
		eq(invoices.status, 'draft'),
		inArray(invoices.roomId, landlordRoomIds)
	];

	const ids = input.ids?.filter((id) => typeof id === 'string' && id.length > 0) ?? [];
	if (ids.length > 0) {
		conditions.push(inArray(invoices.id, ids));
	} else if (input.propertyId && input.month) {
		conditions.push(eq(invoices.month, input.month));
		conditions.push(
			inArray(
				invoices.roomId,
				database
					.select({ id: rooms.id })
					.from(rooms)
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(
						and(eq(properties.landlordId, actor.landlordId), eq(rooms.propertyId, input.propertyId))
					)
			)
		);
	} else {
		throw operationsValidation('Cần chọn hóa đơn (ids) hoặc propertyId + month');
	}

	return database.query.invoices.findMany({
		where: and(...conditions),
		columns: { id: true, roomId: true, totalAmount: true, month: true }
	});
}

export async function assertInvoicesOwnedByLandlord(
	database: FinanceDb,
	actor: LandlordActor,
	invoiceIds: string[]
): Promise<void> {
	if (invoiceIds.length === 0) {
		throw operationsValidation('Chưa chọn hóa đơn');
	}
	const uniqueIds = [...new Set(invoiceIds)];
	for (const id of uniqueIds) {
		await findInvoiceForLandlord(database, actor, id);
	}
}

export async function assertContractOwnedByLandlord(
	database: FinanceDb,
	actor: LandlordActor,
	contractId: string
): Promise<void> {
	await findContractForLandlord(database, actor, contractId);
}

export async function getPaymentAccountForInvoiceLandlord(
	database: FinanceDb,
	actor: LandlordActor,
	invoiceId: string
) {
	const invoice = await findInvoiceForLandlord(database, actor, invoiceId);
	if (!invoice.paymentAccountId) {
		throw operationsValidation('Hóa đơn chưa gắn tài khoản nhận tiền');
	}
	await assertPaymentAccountForLandlordRoom(
		database,
		actor.landlordId,
		invoice.roomId,
		invoice.paymentAccountId
	);
	return findPaymentAccountForLandlord(database, actor, invoice.paymentAccountId);
}

export function mapFinanceScopeError(error: unknown): { status: number; message: string } | null {
	if (error instanceof ScopedResourceNotFoundError) {
		return { status: 404, message: error.message };
	}
	if (isOperationsError(error)) {
		return { status: error.status, message: error.message };
	}
	if (
		error &&
		typeof error === 'object' &&
		'name' in error &&
		error.name === 'AuthorizationError'
	) {
		return { status: 403, message: 'Không có quyền truy cập dữ liệu này' };
	}
	return null;
}
