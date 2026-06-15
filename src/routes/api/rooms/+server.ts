import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	rooms,
	properties,
	services,
	roomServiceConfigs,
	meterReadings,
	roomAssets
} from '$lib/server/db/schema';
import { and, asc, desc, eq } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const propertyId = url.searchParams.get('propertyId');
		const blockId = url.searchParams.get('blockId');
		const tenantId = url.searchParams.get('tenantId');
		const status = url.searchParams.get('status');

		const conditions = [];
		if (status) {
			conditions.push(eq(rooms.status, status));
		}
		if (propertyId) {
			conditions.push(eq(rooms.propertyId, propertyId));
		}
		if (blockId && blockId !== 'all') {
			conditions.push(eq(rooms.blockId, blockId));
		}
		if (tenantId) {
			conditions.push(eq(rooms.tenantId, tenantId));
		}

		const result = await db.query.rooms.findMany({
			where: conditions.length > 0 ? and(...conditions) : undefined,
			with: {
				property: true,
				tenant: {
					with: { user: true }
				},
				services: {
					with: { service: true }
				},
				assets: true,
				meterReadings: {
					orderBy: desc(meterReadings.month)
				}
			},
			orderBy: asc(rooms.roomNumber)
		});

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { propertyId, blockId, roomNumber, roomCode, roomType, floor, monthlyRent, area } = body;

		if (!propertyId || !roomNumber || !roomType || !monthlyRent) {
			return json({ error: 'Missing required room fields' }, { status: 400 });
		}

		// Check if room number already exists in this property
		const existing = await db.query.rooms.findFirst({
			where: and(eq(rooms.propertyId, propertyId), eq(rooms.roomNumber, roomNumber))
		});

		if (existing) {
			return json({ error: 'Số phòng này đã tồn tại trong tòa nhà này' }, { status: 400 });
		}

		const room = await db.transaction(async (tx) => {
			// Create the room
			const r = (
				await tx
					.insert(rooms)
					.values({
						propertyId,
						blockId: blockId || null,
						roomNumber,
						roomCode: roomCode || null,
						roomType,
						floor: floor ? Number(floor) : null,
						status: 'empty',
						monthlyRent: Number(monthlyRent),
						area: area ? Number(area) : null,
						debtAmount: 0
					})
					.returning()
			)[0];

			// Find landlord's services
			const property = (
				await tx
					.select({ landlordId: properties.landlordId })
					.from(properties)
					.where(eq(properties.id, propertyId))
			)[0];

			if (property) {
				const activeServices = await tx
					.select()
					.from(services)
					.where(and(eq(services.landlordId, property.landlordId), eq(services.isActive, true)));
				// Map room to all active services with default rates
				if (activeServices.length > 0) {
					await tx.insert(roomServiceConfigs).values(
						activeServices.map((service) => ({
							roomId: r.id,
							serviceId: service.id,
							customRate: null,
							quantity: 1
						}))
					);
				}
			}

			return r;
		});

		const fullRoom = await db.query.rooms.findFirst({
			where: eq(rooms.id, room.id),
			with: {
				tenant: { with: { user: true } },
				services: { with: { service: true } },
				assets: true,
				meterReadings: true
			}
		});

		return json(fullRoom);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { id, action, ...data } = body;

		if (!id) {
			return json({ error: 'Missing room ID' }, { status: 400 });
		}

		if (action === 'updateMeters') {
			const { serviceId, month, prevValue, currValue, photoUrl } = data;

			if (!serviceId || !month || currValue === undefined || prevValue === undefined) {
				return json({ error: 'Missing meter reading parameters' }, { status: 400 });
			}

			const existingReading = await db.query.meterReadings.findFirst({
				where: and(
					eq(meterReadings.roomId, id),
					eq(meterReadings.serviceId, serviceId),
					eq(meterReadings.month, month)
				)
			});

			if (existingReading) {
				const updateData: Record<string, unknown> = {
					prevValue: Number(prevValue),
					currValue: Number(currValue),
					recordedAt: new Date().toISOString().split('T')[0]
				};
				if (photoUrl) updateData.photoUrl = photoUrl;

				await db
					.update(meterReadings)
					.set(updateData)
					.where(eq(meterReadings.id, existingReading.id));
			} else {
				await db.insert(meterReadings).values({
					roomId: id,
					serviceId,
					month,
					prevValue: Number(prevValue),
					currValue: Number(currValue),
					photoUrl: photoUrl || null,
					recordedAt: new Date().toISOString().split('T')[0]
				});
			}
		} else if (action === 'updateAsset') {
			const { assetId, name, code, status, notes } = data;

			if (!name) {
				return json({ error: 'Missing asset name' }, { status: 400 });
			}

			if (assetId) {
				await db
					.update(roomAssets)
					.set({ name, code, status, notes })
					.where(eq(roomAssets.id, assetId));
			} else {
				await db.insert(roomAssets).values({ roomId: id, name, code, status, notes });
			}
		} else if (action === 'deleteAsset') {
			const { assetId } = data;
			if (assetId) {
				await db.delete(roomAssets).where(eq(roomAssets.id, assetId));
			}
		} else if (action === 'updateServiceConfig') {
			const { configs } = data; // configs: array of { serviceId, customRate, quantity }
			if (configs && Array.isArray(configs)) {
				for (const config of configs) {
					await db
						.update(roomServiceConfigs)
						.set({
							customRate:
								config.customRate === '' || config.customRate === null
									? null
									: Number(config.customRate),
							quantity: Number(config.quantity) || 1
						})
						.where(
							and(
								eq(roomServiceConfigs.roomId, id),
								eq(roomServiceConfigs.serviceId, config.serviceId)
							)
						);
				}
			}
		} else if (action === 'checkout') {
			await db
				.update(rooms)
				.set({
					status: 'empty',
					tenantId: null,
					debtAmount: 0
				})
				.where(eq(rooms.id, id));
		} else {
			// Standard room update
			const updateData: Record<string, unknown> = {};
			if (data.roomNumber !== undefined) updateData.roomNumber = data.roomNumber;
			if (data.roomCode !== undefined) updateData.roomCode = data.roomCode;
			if (data.roomType !== undefined) updateData.roomType = data.roomType;
			if (data.floor !== undefined) updateData.floor = Number(data.floor);
			if (data.monthlyRent !== undefined) updateData.monthlyRent = Number(data.monthlyRent);
			if (data.area !== undefined) updateData.area = Number(data.area);
			if (data.status !== undefined) updateData.status = data.status;
			if (data.debtAmount !== undefined) updateData.debtAmount = Number(data.debtAmount);
			if (data.blockId !== undefined) updateData.blockId = data.blockId;

			if (Object.keys(updateData).length > 0) {
				await db.update(rooms).set(updateData).where(eq(rooms.id, id));
			}
		}

		const updatedRoom = await db.query.rooms.findFirst({
			where: eq(rooms.id, id),
			with: {
				tenant: { with: { user: true } },
				services: { with: { service: true } },
				assets: true,
				meterReadings: {
					orderBy: desc(meterReadings.month)
				}
			}
		});

		return json(updatedRoom);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing room ID' }, { status: 400 });
		}

		await db.delete(rooms).where(eq(rooms.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
