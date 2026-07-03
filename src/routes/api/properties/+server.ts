import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { properties, blocks, landlordProfiles, rooms } from '$lib/server/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { forbidden, landlordOwnsProperty, requireLandlord } from '$lib/server/authz';
import { pricingGroupForRentalType } from '$lib/server/subscription-pricing';

const RENTAL_TYPES = ['APARTMENT', 'MOTEL', 'SERVICED_APARTMENT', 'DORM'] as const;

function normalizeRentalType(value: unknown): (typeof RENTAL_TYPES)[number] {
	const normalized = typeof value === 'string' ? value.trim().toUpperCase() : 'APARTMENT';
	if (normalized === 'COLIVING') return 'APARTMENT';
	return RENTAL_TYPES.includes(normalized as (typeof RENTAL_TYPES)[number])
		? (normalized as (typeof RENTAL_TYPES)[number])
		: 'APARTMENT';
}

async function landlordAllowsRentalType(landlordId: string, rentalType: string) {
	const profile = await db.query.landlordProfiles.findFirst({
		where: (landlordProfiles, { eq }) => eq(landlordProfiles.id, landlordId),
		columns: { enabledRentalTypes: true }
	});
	const enabled = profile?.enabledRentalTypes
		?.split(',')
		.map((type) => (type.trim() === 'COLIVING' ? 'APARTMENT' : type.trim())) ?? ['APARTMENT'];
	return enabled.includes(rentalType);
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;

		// Backward-compatible query param is ignored; session is the source of truth.
		void url;

		const result = await db.query.properties.findMany({
			where: eq(properties.landlordId, landlordId),
			with: {
				blocks: true,
				rooms: {
					columns: { id: true, roomNumber: true, status: true, roomType: true, monthlyRent: true }
				}
			},
			orderBy: asc(properties.name)
		});

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;

		const body = await request.json();
		const { name, shortName, address, blocks: blockNames } = body;
		const rentalType = normalizeRentalType(body.rentalType);

		if (!landlordId || !name || !shortName || !address) {
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
			// Create property
			const prop = (
				await tx
					.insert(properties)
					.values({ landlordId, name, shortName, address, rentalType })
					.returning()
			)[0];

			// Create initial blocks if specified
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

		const fullProperty = await db.query.properties.findFirst({
			where: eq(properties.id, property.id),
			with: {
				blocks: true,
				rooms: true
			}
		});

		return json(fullProperty);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const { id, name, shortName, address, blocks: blockNames } = body;

		if (!id) {
			return json({ error: 'Missing property ID' }, { status: 400 });
		}
		if (!(await landlordOwnsProperty(auth.value, id))) {
			return forbidden();
		}
		const requestedRentalType =
			body.rentalType !== undefined ? normalizeRentalType(body.rentalType) : null;
		if (requestedRentalType && !(await landlordAllowsRentalType(auth.value, requestedRentalType))) {
			return json({ error: 'Tài khoản chủ trọ chưa được bật loại hình này' }, { status: 403 });
		}

		const updateResult = await db.transaction(async (tx) => {
			if (requestedRentalType) {
				await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${auth.value}))`);
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
							.where(eq(landlordProfiles.id, auth.value))
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
											eq(properties.landlordId, auth.value),
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
			// Update property details
			const updateData: Record<string, unknown> = {};
			if (name !== undefined) updateData.name = name;
			if (shortName !== undefined) updateData.shortName = shortName;
			if (address !== undefined) updateData.address = address;
			if (requestedRentalType) updateData.rentalType = requestedRentalType;

			if (Object.keys(updateData).length > 0) {
				await tx.update(properties).set(updateData).where(eq(properties.id, id));
			}

			// Synchronize blocks (add new ones, keep existing ones)
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

		const fullProperty = await db.query.properties.findFirst({
			where: eq(properties.id, id),
			with: {
				blocks: true,
				rooms: true
			}
		});

		return json(fullProperty);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing property ID' }, { status: 400 });
		}
		if (!(await landlordOwnsProperty(auth.value, id))) {
			return forbidden();
		}

		await db.delete(properties).where(eq(properties.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
