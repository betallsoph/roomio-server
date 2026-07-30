import { and, desc, eq, inArray } from 'drizzle-orm';
import {
	announcements,
	invoices,
	maintenanceRequests,
	managedTenants,
	notificationQueue,
	properties,
	rooms,
	specialNotes,
	tenancies
} from '$lib/server/db/schema';
import type { LandlordActor, TenantActor } from '$lib/server/authorization/actor';
import { listClaimedTenancyScopesForTenant } from '$lib/server/operations/active-tenancy';
import {
	communicationsForbidden,
	communicationsNotFound,
	type CommunicationsDb
} from './errors.js';

export async function assertNotificationRecipientScoped(
	database: CommunicationsDb,
	notification: typeof notificationQueue.$inferSelect
): Promise<void> {
	if (!notification.tenantId) {
		throw communicationsNotFound();
	}

	const tenantLandlordRows = await database
		.select({ landlordId: properties.landlordId })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(eq(rooms.tenantId, notification.tenantId))
		.limit(1);

	const tenantLandlordId = tenantLandlordRows[0]?.landlordId;
	if (!tenantLandlordId || tenantLandlordId !== notification.landlordId) {
		throw communicationsNotFound();
	}

	if (notification.managedTenantId) {
		const managedTenant = await database.query.managedTenants.findFirst({
			where: and(
				eq(managedTenants.id, notification.managedTenantId),
				eq(managedTenants.landlordId, notification.landlordId)
			),
			columns: { id: true }
		});
		if (!managedTenant) throw communicationsNotFound();
	}

	if (notification.tenancyId) {
		const tenancy = await database.query.tenancies.findFirst({
			where: and(
				eq(tenancies.id, notification.tenancyId),
				eq(tenancies.landlordId, notification.landlordId)
			),
			columns: { id: true }
		});
		if (!tenancy) throw communicationsNotFound();
	}

	if (!notification.relatedType || !notification.relatedId) return;

	switch (notification.relatedType) {
		case 'announcement': {
			const row = await database.query.announcements.findFirst({
				where: and(
					eq(announcements.id, notification.relatedId),
					eq(announcements.landlordId, notification.landlordId)
				),
				columns: { id: true }
			});
			if (!row) throw communicationsNotFound();
			return;
		}
		case 'message':
			return;
		case 'invoice': {
			const rows = await database
				.select({ id: invoices.id })
				.from(invoices)
				.innerJoin(rooms, eq(invoices.roomId, rooms.id))
				.innerJoin(properties, eq(rooms.propertyId, properties.id))
				.where(
					and(
						eq(invoices.id, notification.relatedId),
						eq(properties.landlordId, notification.landlordId)
					)
				)
				.limit(1);
			if (!rows[0]) throw communicationsNotFound();
			return;
		}
		case 'request': {
			const row = await database.query.maintenanceRequests.findFirst({
				where: and(
					eq(maintenanceRequests.id, notification.relatedId),
					eq(maintenanceRequests.landlordId, notification.landlordId)
				),
				columns: { id: true }
			});
			if (!row) throw communicationsNotFound();
		}
	}
}

export async function listSpecialNotesForTenant(database: CommunicationsDb, actor: TenantActor) {
	const scopes = await listClaimedTenancyScopesForTenant(database, actor);
	if (scopes.length === 0) return [];

	const managedTenantIds = scopes.map((scope) => scope.managedTenantId);
	const landlordIds = [...new Set(scopes.map((scope) => scope.landlordId))];

	return database.query.specialNotes.findMany({
		where: and(
			inArray(specialNotes.managedTenantId, managedTenantIds),
			inArray(specialNotes.landlordId, landlordIds)
		),
		orderBy: desc(specialNotes.createdAt)
	});
}

export async function listSpecialNotesForLandlord(
	database: CommunicationsDb,
	actor: LandlordActor
) {
	return database.query.specialNotes.findMany({
		where: eq(specialNotes.landlordId, actor.landlordId),
		orderBy: desc(specialNotes.createdAt)
	});
}

export async function createSpecialNoteForActor(
	database: CommunicationsDb,
	actor: LandlordActor | TenantActor,
	input: { managedTenantId?: string | null; tenancyId?: string | null; content: string }
) {
	const content = input.content.trim();
	if (!content) throw communicationsNotFound();

	if (actor.role === 'TENANT') {
		const scopes = await listClaimedTenancyScopesForTenant(database, actor);
		const scope =
			(input.tenancyId
				? scopes.find((row) => row.tenancyId === input.tenancyId)
				: scopes.find((row) => row.status === 'ACTIVE')) ?? scopes[0];
		if (!scope?.tenantProfileId) throw communicationsForbidden();

		const [created] = await database
			.insert(specialNotes)
			.values({
				landlordId: scope.landlordId,
				tenantId: scope.tenantProfileId,
				managedTenantId: scope.managedTenantId,
				tenancyId: scope.tenancyId,
				content,
				sender: 'TENANT',
				isRead: false
			})
			.returning();
		return created;
	}

	const managedTenantId = input.managedTenantId?.trim();
	if (!managedTenantId) throw communicationsNotFound();

	const managedTenant = await database.query.managedTenants.findFirst({
		where: and(
			eq(managedTenants.id, managedTenantId),
			eq(managedTenants.landlordId, actor.landlordId)
		),
		columns: { id: true, legacyTenantProfileId: true }
	});
	if (!managedTenant?.legacyTenantProfileId) throw communicationsNotFound();

	let tenancyId: string | null = null;
	if (input.tenancyId) {
		const tenancy = await database.query.tenancies.findFirst({
			where: and(
				eq(tenancies.id, input.tenancyId),
				eq(tenancies.landlordId, actor.landlordId),
				eq(tenancies.managedTenantId, managedTenant.id)
			),
			columns: { id: true }
		});
		if (!tenancy) throw communicationsNotFound();
		tenancyId = tenancy.id;
	}

	const [created] = await database
		.insert(specialNotes)
		.values({
			landlordId: actor.landlordId,
			tenantId: managedTenant.legacyTenantProfileId,
			managedTenantId: managedTenant.id,
			tenancyId,
			content,
			sender: 'LANDLORD',
			isRead: false
		})
		.returning();

	return created;
}

export async function markSpecialNoteReadForActor(
	database: CommunicationsDb,
	actor: LandlordActor | TenantActor,
	noteId: string,
	isRead = true
) {
	const note = await database.query.specialNotes.findFirst({
		where: eq(specialNotes.id, noteId)
	});
	if (!note) throw communicationsNotFound();

	if (actor.role === 'TENANT') {
		const scopes = await listClaimedTenancyScopesForTenant(database, actor);
		const allowed = scopes.some((scope) => scope.managedTenantId === note.managedTenantId);
		if (!allowed) throw communicationsForbidden();
	} else if (note.landlordId !== actor.landlordId) {
		throw communicationsNotFound();
	}

	const [updated] = await database
		.update(specialNotes)
		.set({ isRead })
		.where(eq(specialNotes.id, noteId))
		.returning();

	return updated;
}
