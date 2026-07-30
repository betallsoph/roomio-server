import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import {
	announcements,
	blocks,
	managedTenants,
	properties,
	rooms,
	tenancies
} from '$lib/server/db/schema';
import type { LandlordActor, StaffActor, TenantActor } from '$lib/server/authorization/actor';
import { forbiddenError } from '$lib/server/authorization/errors';
import { staffHasPermission } from '$lib/server/authorization/staff-scope';
import { listClaimedTenancyScopesForTenant } from '$lib/server/operations/active-tenancy';
import { communicationsNotFound, communicationsValidation } from './errors.js';
import type { CommunicationsDb } from './errors.js';

export type AnnouncementTargetType = 'ALL' | 'PROPERTY' | 'BLOCK' | 'ROOM' | 'TENANT';

export type AnnouncementRow = typeof announcements.$inferSelect;

function assignedPropertyIds(actor: StaffActor): string[] {
	return actor.propertyIds.length > 0 ? actor.propertyIds : ['__none__'];
}

async function assertTargetOwnedByLandlord(
	database: CommunicationsDb,
	landlordId: string,
	targetType: AnnouncementTargetType,
	targetId: string | null
) {
	if (targetType === 'ALL') return;
	if (!targetId) {
		throw communicationsValidation('Thiếu targetId cho loại đích cụ thể');
	}

	switch (targetType) {
		case 'PROPERTY': {
			const row = await database.query.properties.findFirst({
				where: and(eq(properties.id, targetId), eq(properties.landlordId, landlordId)),
				columns: { id: true }
			});
			if (!row) throw communicationsNotFound();
			return;
		}
		case 'BLOCK': {
			const row = await database.query.blocks.findFirst({
				where: eq(blocks.id, targetId),
				with: { property: { columns: { landlordId: true } } }
			});
			if (!row || row.property.landlordId !== landlordId) throw communicationsNotFound();
			return;
		}
		case 'ROOM': {
			const rows = await database
				.select({ id: rooms.id })
				.from(rooms)
				.innerJoin(properties, eq(rooms.propertyId, properties.id))
				.where(and(eq(rooms.id, targetId), eq(properties.landlordId, landlordId)))
				.limit(1);
			if (!rows[0]) throw communicationsNotFound();
			return;
		}
		case 'TENANT': {
			const row = await database.query.managedTenants.findFirst({
				where: and(eq(managedTenants.id, targetId), eq(managedTenants.landlordId, landlordId)),
				columns: { id: true }
			});
			if (!row) throw communicationsNotFound();
		}
	}
}

function tenantAnnouncementMatch(scope: {
	landlordId: string;
	managedTenantId: string;
	propertyId: string;
	roomId: string;
	blockId: string | null;
}): SQL {
	return and(
		eq(announcements.landlordId, scope.landlordId),
		or(
			and(eq(announcements.targetType, 'ALL'), isNull(announcements.targetId)),
			and(
				eq(announcements.targetType, 'TENANT'),
				eq(announcements.targetId, scope.managedTenantId)
			),
			and(eq(announcements.targetType, 'ROOM'), eq(announcements.targetId, scope.roomId)),
			scope.blockId
				? and(eq(announcements.targetType, 'BLOCK'), eq(announcements.targetId, scope.blockId))
				: undefined,
			and(eq(announcements.targetType, 'PROPERTY'), eq(announcements.targetId, scope.propertyId))
		)
	)!;
}

async function tenantAnnouncementScopes(database: CommunicationsDb, actor: TenantActor) {
	const tenancyScopes = await listClaimedTenancyScopesForTenant(database, actor);
	if (tenancyScopes.length === 0) return [];

	const roomIds = [...new Set(tenancyScopes.map((scope) => scope.roomId))];
	const roomRows =
		roomIds.length === 0
			? []
			: await database
					.select({ id: rooms.id, blockId: rooms.blockId })
					.from(rooms)
					.where(inArray(rooms.id, roomIds));

	const blockByRoomId = new Map(roomRows.map((row) => [row.id, row.blockId]));

	return tenancyScopes.map((scope) => ({
		landlordId: scope.landlordId,
		managedTenantId: scope.managedTenantId,
		propertyId: scope.propertyId,
		roomId: scope.roomId,
		blockId: blockByRoomId.get(scope.roomId) ?? null
	}));
}

export async function listAnnouncementsForTenant(
	database: CommunicationsDb,
	actor: TenantActor
): Promise<AnnouncementRow[]> {
	const scopes = await tenantAnnouncementScopes(database, actor);
	if (scopes.length === 0) return [];

	const predicates = scopes.map((scope) => tenantAnnouncementMatch(scope));
	const rows = await database
		.select()
		.from(announcements)
		.where(or(...predicates))
		.orderBy(desc(announcements.isImportant), desc(announcements.createdAt));

	const seen = new Set<string>();
	return rows.filter((row) => {
		if (seen.has(row.id)) return false;
		seen.add(row.id);
		return true;
	});
}

export async function listAnnouncementsForLandlord(
	database: CommunicationsDb,
	actor: LandlordActor,
	filters: { targetType?: string | null; targetId?: string | null } = {}
): Promise<AnnouncementRow[]> {
	const conditions = [eq(announcements.landlordId, actor.landlordId)];
	if (filters.targetType) conditions.push(eq(announcements.targetType, filters.targetType));
	if (filters.targetId) conditions.push(eq(announcements.targetId, filters.targetId));

	return database
		.select()
		.from(announcements)
		.where(and(...conditions))
		.orderBy(desc(announcements.createdAt));
}

export async function listAnnouncementsForStaff(
	database: CommunicationsDb,
	actor: StaffActor,
	filters: { targetType?: string | null; targetId?: string | null } = {}
): Promise<AnnouncementRow[]> {
	if (!staffHasPermission(actor, 'VIEW_TENANTS')) {
		throw forbiddenError();
	}

	const propertyIds = assignedPropertyIds(actor);
	const tenantIds = database
		.select({ id: managedTenants.id })
		.from(managedTenants)
		.innerJoin(
			tenancies,
			and(
				eq(tenancies.managedTenantId, managedTenants.id),
				eq(tenancies.status, 'ACTIVE'),
				inArray(tenancies.propertyId, propertyIds)
			)
		)
		.where(eq(managedTenants.landlordId, actor.landlordId));

	const conditions = [
		eq(announcements.landlordId, actor.landlordId),
		or(
			and(eq(announcements.targetType, 'ALL'), isNull(announcements.targetId)),
			and(eq(announcements.targetType, 'PROPERTY'), inArray(announcements.targetId, propertyIds)),
			and(eq(announcements.targetType, 'TENANT'), inArray(announcements.targetId, tenantIds))
		)
	];
	if (filters.targetType) conditions.push(eq(announcements.targetType, filters.targetType));
	if (filters.targetId) conditions.push(eq(announcements.targetId, filters.targetId));

	return database
		.select()
		.from(announcements)
		.where(and(...conditions))
		.orderBy(desc(announcements.createdAt));
}

export async function createAnnouncementForLandlord(
	database: CommunicationsDb,
	actor: LandlordActor,
	input: {
		title: string;
		content: string;
		isImportant?: boolean;
		targetType?: string;
		targetId?: string | null;
	}
): Promise<AnnouncementRow> {
	const targetType = (
		['ALL', 'PROPERTY', 'BLOCK', 'ROOM', 'TENANT'].includes(input.targetType ?? '')
			? input.targetType
			: 'ALL'
	) as AnnouncementTargetType;
	const targetId = input.targetId ?? null;

	await assertTargetOwnedByLandlord(database, actor.landlordId, targetType, targetId);

	const [created] = await database
		.insert(announcements)
		.values({
			landlordId: actor.landlordId,
			senderId: actor.userId,
			title: input.title,
			content: input.content,
			isImportant: !!input.isImportant,
			targetType,
			targetId
		})
		.returning();

	return created;
}

export async function deleteAnnouncementForLandlord(
	database: CommunicationsDb,
	actor: LandlordActor,
	announcementId: string
): Promise<void> {
	const row = await database.query.announcements.findFirst({
		where: and(eq(announcements.id, announcementId), eq(announcements.landlordId, actor.landlordId)),
		columns: { id: true }
	});
	if (!row) throw communicationsNotFound();
	await database.delete(announcements).where(eq(announcements.id, announcementId));
}
