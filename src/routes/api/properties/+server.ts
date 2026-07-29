import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { properties, blocks, landlordProfiles, rooms } from '$lib/server/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { pricingGroupForRentalType } from '$lib/server/subscription-pricing';
import {
	canonicalRentalType,
	isValidOperatingModel,
	normalizeRentalTypeOr,
	type OperatingModel
} from '$lib/server/rental-types';
import { toPropertyDto } from '$lib/server/dto/properties';
import {
	findPropertyDetailForActor,
	listPropertiesForActor,
	propertyScopeErrorToResponse,
	requireLandlordMutationActor,
	requireOperationalActor,
	deletePropertyScoped,
	requireScopedProperty,
	updatePropertyScoped
} from '$lib/server/property-scope';

const INVALID_OPERATING_MODEL_ERROR = 'Mô hình vận hành không hợp lệ';

function resolveOperatingModelForPost(
	value: unknown
): { ok: true; value: OperatingModel } | { ok: false } {
	if (value === undefined || value === null) {
		return { ok: true, value: 'UNSPECIFIED' };
	}
	const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
	if (!isValidOperatingModel(normalized)) {
		return { ok: false };
	}
	return { ok: true, value: normalized };
}

function resolveOperatingModelForPut(
	value: unknown
): { ok: true; value: OperatingModel } | { ok: true; skip: true } | { ok: false } {
	if (value === undefined) {
		return { ok: true, skip: true };
	}
	if (value === null) {
		return { ok: true, value: 'UNSPECIFIED' };
	}
	const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
	if (!isValidOperatingModel(normalized)) {
		return { ok: false };
	}
	return { ok: true, value: normalized };
}

async function landlordAllowsRentalType(landlordId: string, rentalType: string) {
	const profile = await db.query.landlordProfiles.findFirst({
		where: (landlordProfiles, { eq }) => eq(landlordProfiles.id, landlordId),
		columns: { enabledRentalTypes: true }
	});
	const enabled = profile?.enabledRentalTypes?.split(',').map(canonicalRentalType) ?? ['APARTMENT'];
	return enabled.includes(rentalType);
}

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const result = await listPropertiesForActor(db, actorResult.actor);
		return json(result.map(toPropertyDto));
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
		const { name, shortName, address, blocks: blockNames } = body;
		const rentalType = normalizeRentalTypeOr(body.rentalType);
		const operatingModelResult = resolveOperatingModelForPost(body.operatingModel);
		if (!operatingModelResult.ok) {
			return json({ error: INVALID_OPERATING_MODEL_ERROR }, { status: 400 });
		}

		if (!name || !shortName || !address) {
			return json({ error: 'Missing required property fields' }, { status: 400 });
		}
		if (!(await landlordAllowsRentalType(landlordId, rentalType))) {
			return json({ error: 'Tài khoản chủ trọ chưa được bật loại hình này' }, { status: 403 });
		}
		if (
			rentalType === 'APARTMENT' &&
			(!Array.isArray(blockNames) ||
				blockNames.map((blockName: string) => blockName.trim()).filter(Boolean).length === 0)
		) {
			return json({ error: 'Chung cư cần có ít nhất một block' }, { status: 400 });
		}

		const property = await db.transaction(async (tx) => {
			const prop = (
				await tx
					.insert(properties)
					.values({
						landlordId,
						name,
						shortName,
						address,
						rentalType,
						operatingModel: operatingModelResult.value
					})
					.returning()
			)[0];

			if (blockNames && Array.isArray(blockNames)) {
				const values = blockNames
					.map((blockName: string) => blockName.trim())
					.filter((blockName: string) => blockName)
					.map((blockName: string) => ({ propertyId: prop.id, name: blockName }));

				if (values.length > 0) {
					await tx.insert(blocks).values(values);
				}
			}

			return prop;
		});

		const fullProperty = await findPropertyDetailForActor(db, actorResult.actor, property.id);
		return json(toPropertyDto(fullProperty));
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
		const { id, name, shortName, address, blocks: blockNames } = body;

		if (!id) {
			return json({ error: 'Missing property ID' }, { status: 400 });
		}

		const requestedRentalType =
			body.rentalType !== undefined ? normalizeRentalTypeOr(body.rentalType) : null;
		const operatingModelResult = resolveOperatingModelForPut(body.operatingModel);
		if (!operatingModelResult.ok) {
			return json({ error: INVALID_OPERATING_MODEL_ERROR }, { status: 400 });
		}
		if (
			requestedRentalType &&
			!(await landlordAllowsRentalType(actorResult.actor.landlordId, requestedRentalType))
		) {
			return json({ error: 'Tài khoản chủ trọ chưa được bật loại hình này' }, { status: 403 });
		}

		// Scope gate before any scalar or block mutation — blocks-only PUT must not bypass ownership.
		await requireScopedProperty(db, actorResult.actor, id);

		const updateResult = await db.transaction(async (tx) => {
			if (requestedRentalType) {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${actorResult.actor.landlordId}))`
				);
				const currentProperty = (
					await tx
						.select({ rentalType: properties.rentalType })
						.from(properties)
						.where(eq(properties.id, id))
				)[0];
				if (
					currentProperty &&
					currentProperty.rentalType !== requestedRentalType &&
					pricingGroupForRentalType(currentProperty.rentalType) !==
						pricingGroupForRentalType(requestedRentalType)
				) {
					const profile = (
						await tx
							.select({
								standardLimit: landlordProfiles.subscribedStandardRoomLimit,
								colivingLimit: landlordProfiles.subscribedColivingRoomLimit
							})
							.from(landlordProfiles)
							.where(eq(landlordProfiles.id, actorResult.actor.landlordId))
					)[0];
					const targetIsColiving = pricingGroupForRentalType(requestedRentalType) === 'COLIVING';
					const targetLimit = targetIsColiving ? profile?.colivingLimit : profile?.standardLimit;
					if (targetLimit !== null && targetLimit !== undefined) {
						const propertyRoomCount = Number(
							(
								await tx
									.select({ count: sql<number>`count(${rooms.id})` })
									.from(rooms)
									.where(eq(rooms.propertyId, id))
							)[0]?.count ?? 0
						);
						const targetRoomCount = Number(
							(
								await tx
									.select({ count: sql<number>`count(${rooms.id})` })
									.from(properties)
									.leftJoin(rooms, eq(rooms.propertyId, properties.id))
									.where(
										and(
											eq(properties.landlordId, actorResult.actor.landlordId),
											targetIsColiving
												? sql`${properties.rentalType} in ('APARTMENT', 'COLIVING')`
												: sql`${properties.rentalType} not in ('APARTMENT', 'COLIVING')`
										)
									)
							)[0]?.count ?? 0
						);
						if (targetRoomCount + propertyRoomCount > targetLimit) {
							return {
								error: `Chuyển loại hình sẽ vượt hạn mức ${targetLimit} phòng ${targetIsColiving ? 'chung cư / co-living' : 'tiêu chuẩn'}`
							};
						}
					}
				}
			}

			const updateData: Record<string, unknown> = {};
			if (name !== undefined) updateData.name = name;
			if (shortName !== undefined) updateData.shortName = shortName;
			if (address !== undefined) updateData.address = address;
			if (requestedRentalType) updateData.rentalType = requestedRentalType;
			if ('value' in operatingModelResult) {
				updateData.operatingModel = operatingModelResult.value;
			}

			if (Object.keys(updateData).length > 0) {
				await updatePropertyScoped(tx, actorResult.actor, id, updateData);
			}

			if (blockNames && Array.isArray(blockNames)) {
				const existingBlocks = await tx.select().from(blocks).where(eq(blocks.propertyId, id));
				const existingNames = existingBlocks.map((b) => b.name);

				const newBlocks = blockNames
					.map((blockName: string) => blockName.trim())
					.filter((blockName: string) => blockName && !existingNames.includes(blockName))
					.map((blockName: string) => ({ propertyId: id, name: blockName }));

				if (newBlocks.length > 0) {
					await tx.insert(blocks).values(newBlocks);
				}
			}
			return { success: true };
		});
		if ('error' in updateResult) return json({ error: updateResult.error }, { status: 403 });

		const fullProperty = await findPropertyDetailForActor(db, actorResult.actor, id);
		return json(toPropertyDto(fullProperty));
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
			return json({ error: 'Missing property ID' }, { status: 400 });
		}

		await deletePropertyScoped(db, actorResult.actor, id);
		return json({ success: true });
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
