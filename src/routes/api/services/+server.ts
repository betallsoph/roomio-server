import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { services, rooms, properties, roomServiceConfigs } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { toServiceDto, toServiceListDto } from '$lib/server/dto/services';
import {
	deleteServiceScoped,
	listServicesForActor,
	propertyScopeErrorToResponse,
	requireLandlordMutationActor,
	requireOperationalActor,
	updateServiceScoped
} from '$lib/server/property-scope';

const SERVICE_TYPES = ['METERED', 'MANUAL_AMOUNT', 'FLAT_ROOM', 'FLAT_PERSON', 'FLAT_VEHICLE'];

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const result = await listServicesForActor(db, actorResult.actor);
		return json(toServiceListDto(result));
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const landlordId = actorResult.actor.landlordId;

		const body = await request.json();
		const { name, type, defaultRate, isActive } = body;

		if (!name || !type || defaultRate === undefined) {
			return json({ error: 'Missing required service fields' }, { status: 400 });
		}
		if (!SERVICE_TYPES.includes(type)) {
			return json({ error: 'Cách tính dịch vụ không hợp lệ' }, { status: 400 });
		}

		const service = await db.transaction(async (tx) => {
			const created = (
				await tx
					.insert(services)
					.values({
						landlordId,
						name,
						type,
						defaultRate: Number(defaultRate),
						isActive: isActive !== undefined ? isActive : true
					})
					.returning()
			)[0];

			const landlordRooms = await tx
				.select({ id: rooms.id })
				.from(rooms)
				.innerJoin(properties, eq(rooms.propertyId, properties.id))
				.where(eq(properties.landlordId, landlordId));
			if (landlordRooms.length > 0) {
				await tx.insert(roomServiceConfigs).values(
					landlordRooms.map((room) => ({
						roomId: room.id,
						serviceId: created.id,
						customRate: null,
						quantity: 1
					}))
				);
			}

			return created;
		});

		return json(toServiceDto(service));
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const body = await request.json();
		const { id, name, defaultRate, isActive } = body;

		if (!id) {
			return json({ error: 'Missing service ID' }, { status: 400 });
		}

		const updateData: Record<string, unknown> = {};
		if (name !== undefined) updateData.name = name;
		if (defaultRate !== undefined) updateData.defaultRate = Number(defaultRate);
		if (isActive !== undefined) updateData.isActive = isActive;

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		const updated = await updateServiceScoped(db, actorResult.actor, id, updateData);
		return json(toServiceDto(updated));
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const id = url.searchParams.get('id');
		if (!id) {
			return json({ error: 'Missing service ID' }, { status: 400 });
		}

		await deleteServiceScoped(db, actorResult.actor, id);
		return json({ success: true });
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
