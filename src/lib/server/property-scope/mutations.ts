import { and, eq } from 'drizzle-orm';
import type { db as AppDb } from '$lib/server/db';
import {
	blocks,
	properties,
	roomAssets,
	roomServiceConfigs,
	rooms,
	services
} from '$lib/server/db/schema';
import type { LandlordActor } from '$lib/server/authorization/actor';
import {
	findPropertyForLandlord,
	findRoomAssetForLandlord,
	findRoomForLandlord,
	findServiceForLandlord,
	ScopedResourceNotFoundError,
	type ScopedQueryDb
} from '$lib/server/authorization/scoped-queries';

export type PropertyMutationDb = Pick<
	typeof AppDb,
	'query' | 'select' | 'insert' | 'update' | 'delete' | 'transaction'
>;

export async function requireScopedProperty(
	database: ScopedQueryDb,
	actor: LandlordActor,
	propertyId: string
) {
	return findPropertyForLandlord(database, actor, propertyId);
}

export async function requireScopedRoom(
	database: ScopedQueryDb,
	actor: LandlordActor,
	roomId: string
) {
	return findRoomForLandlord(database, actor, roomId);
}

export async function requireScopedService(
	database: ScopedQueryDb,
	actor: LandlordActor,
	serviceId: string
) {
	return findServiceForLandlord(database, actor, serviceId);
}

export async function assertBlockInScopedProperty(
	database: ScopedQueryDb,
	actor: LandlordActor,
	propertyId: string,
	blockId: string
): Promise<void> {
	await requireScopedProperty(database, actor, propertyId);
	const block = await database.query.blocks.findFirst({
		where: and(eq(blocks.id, blockId), eq(blocks.propertyId, propertyId)),
		columns: { id: true }
	});
	if (!block) {
		throw new ScopedResourceNotFoundError('Block không thuộc tòa nhà đã chọn');
	}
}

export async function assertRoomServiceSameLandlord(
	database: ScopedQueryDb,
	actor: LandlordActor,
	roomId: string,
	serviceId: string
): Promise<void> {
	const room = await findRoomForLandlord(database, actor, roomId);
	const service = await findServiceForLandlord(database, actor, serviceId);
	const property = await database.query.properties.findFirst({
		where: eq(properties.id, room.propertyId),
		columns: { landlordId: true }
	});
	if (!property || property.landlordId !== service.landlordId) {
		throw new ScopedResourceNotFoundError();
	}
}

export async function updateRoomAssetScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	input: {
		roomId: string;
		assetId?: string | null;
		name: string;
		code?: string | null;
		status?: string | null;
		notes?: string | null;
	}
) {
	await findRoomForLandlord(database, actor, input.roomId);

	if (input.assetId) {
		await findRoomAssetForLandlord(database, actor, {
			roomId: input.roomId,
			assetId: input.assetId
		});
		const updated = await database
			.update(roomAssets)
			.set({
				name: input.name,
				code: input.code ?? null,
				status: input.status ?? 'good',
				notes: input.notes ?? null
			})
			.where(and(eq(roomAssets.id, input.assetId), eq(roomAssets.roomId, input.roomId)))
			.returning();
		if (updated.length === 0) {
			throw new ScopedResourceNotFoundError();
		}
		return updated[0];
	}

	const created = await database
		.insert(roomAssets)
		.values({
			roomId: input.roomId,
			name: input.name,
			code: input.code ?? null,
			status: input.status ?? 'good',
			notes: input.notes ?? null
		})
		.returning();
	return created[0];
}

export async function deleteRoomAssetScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	input: { roomId: string; assetId: string }
) {
	await findRoomAssetForLandlord(database, actor, input);
	const deleted = await database
		.delete(roomAssets)
		.where(and(eq(roomAssets.id, input.assetId), eq(roomAssets.roomId, input.roomId)))
		.returning({ id: roomAssets.id });
	if (deleted.length === 0) {
		throw new ScopedResourceNotFoundError();
	}
}

export async function updateRoomServiceConfigsScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	roomId: string,
	configs: Array<{ serviceId: string; customRate?: unknown; quantity?: unknown }>
) {
	await findRoomForLandlord(database, actor, roomId);

	for (const config of configs) {
		await assertRoomServiceSameLandlord(database, actor, roomId, config.serviceId);
		const updated = await database
			.update(roomServiceConfigs)
			.set({
				customRate:
					config.customRate === '' || config.customRate === null || config.customRate === undefined
						? null
						: Number(config.customRate),
				quantity: Number(config.quantity) || 1
			})
			.where(
				and(
					eq(roomServiceConfigs.roomId, roomId),
					eq(roomServiceConfigs.serviceId, config.serviceId)
				)
			)
			.returning();
		if (updated.length === 0) {
			throw new ScopedResourceNotFoundError();
		}
	}
}

export async function deletePropertyScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	propertyId: string
): Promise<void> {
	await findPropertyForLandlord(database, actor, propertyId);
	const deleted = await database
		.delete(properties)
		.where(eq(properties.id, propertyId))
		.returning({ id: properties.id });
	if (deleted.length === 0) {
		throw new ScopedResourceNotFoundError();
	}
}

export async function deleteRoomScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	roomId: string
): Promise<void> {
	await findRoomForLandlord(database, actor, roomId);
	const deleted = await database
		.delete(rooms)
		.where(eq(rooms.id, roomId))
		.returning({ id: rooms.id });
	if (deleted.length === 0) {
		throw new ScopedResourceNotFoundError();
	}
}

export async function deleteServiceScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	serviceId: string
): Promise<void> {
	await findServiceForLandlord(database, actor, serviceId);
	const deleted = await database
		.delete(services)
		.where(eq(services.id, serviceId))
		.returning({ id: services.id });
	if (deleted.length === 0) {
		throw new ScopedResourceNotFoundError();
	}
}

export async function updateServiceScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	serviceId: string,
	updateData: Record<string, unknown>
) {
	await findServiceForLandlord(database, actor, serviceId);
	const updated = await database
		.update(services)
		.set(updateData)
		.where(eq(services.id, serviceId))
		.returning();
	if (updated.length === 0) {
		throw new ScopedResourceNotFoundError();
	}
	return updated[0];
}

export async function updatePropertyScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	propertyId: string,
	updateData: Record<string, unknown>
) {
	await findPropertyForLandlord(database, actor, propertyId);
	const updated = await database
		.update(properties)
		.set(updateData)
		.where(eq(properties.id, propertyId))
		.returning();
	if (updated.length === 0) {
		throw new ScopedResourceNotFoundError();
	}
	return updated[0];
}

export async function updateRoomScoped(
	database: PropertyMutationDb,
	actor: LandlordActor,
	roomId: string,
	updateData: Record<string, unknown>
) {
	await findRoomForLandlord(database, actor, roomId);
	const updated = await database
		.update(rooms)
		.set(updateData)
		.where(eq(rooms.id, roomId))
		.returning();
	if (updated.length === 0) {
		throw new ScopedResourceNotFoundError();
	}
	return updated[0];
}
