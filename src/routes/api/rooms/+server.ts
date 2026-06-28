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
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
	forbidden,
	landlordOwnsProperty,
	landlordOwnsRoom,
	requireLandlord
} from '$lib/server/authz';
import { normalizeRoomCodeForProperty, normalizeRoomTextKey } from '$lib/server/room-code';

// Định danh CĂN của một phòng: ưu tiên mã chuẩn hóa (vd HAGL3 "A16-04"); không có thì dùng mã căn
// dạng text; không có mã căn thì coi như không thuộc căn nào ('').
function roomUnitKey(propertyId: string, roomNumber: string, roomCode: string | null) {
	const canonical =
		normalizeRoomCodeForProperty(propertyId, roomCode) ??
		normalizeRoomCodeForProperty(propertyId, roomNumber);
	return canonical ?? normalizeRoomTextKey(roomCode);
}

// Một MÃ CĂN có thể chứa NHIỀU PHÒNG (cho thuê theo phòng/giường). Vì vậy chỉ coi là TRÙNG khi
// CÙNG mã căn VÀ CÙNG tên phòng — không chặn việc thêm phòng mới vào căn đã tồn tại.
async function findDuplicateRoom(
	propertyId: string,
	roomNumber: string,
	roomCode: string | null,
	excludeRoomId?: string
) {
	const targetUnit = roomUnitKey(propertyId, roomNumber, roomCode);
	const targetName = normalizeRoomTextKey(roomNumber);
	if (!targetUnit && !targetName) return undefined;

	const propertyRooms = await db.query.rooms.findMany({
		where: eq(rooms.propertyId, propertyId),
		columns: { id: true, roomNumber: true, roomCode: true }
	});

	return propertyRooms.find((room) => {
		if (excludeRoomId && room.id === excludeRoomId) return false;
		const existingUnit = roomUnitKey(propertyId, room.roomNumber, room.roomCode);
		const existingName = normalizeRoomTextKey(room.roomNumber);
		return existingUnit === targetUnit && existingName === targetName;
	});
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const propertyId = url.searchParams.get('propertyId');
		const blockId = url.searchParams.get('blockId');
		const tenantId = url.searchParams.get('tenantId');
		const status = url.searchParams.get('status');
		const landlordId = url.searchParams.get('landlordId');

		const conditions = [];
		if (locals.session?.role === 'LANDLORD') {
			conditions.push(
				inArray(
					rooms.propertyId,
					db
						.select({ id: properties.id })
						.from(properties)
						.where(eq(properties.landlordId, locals.session.landlordProfileId!))
				)
			);
		}
		if (locals.session?.role === 'TENANT') {
			if (!locals.session.tenantProfileId) return forbidden();
			conditions.push(eq(rooms.tenantId, locals.session.tenantProfileId));
		}
		if (locals.session?.role === 'STAFF') {
			conditions.push(
				inArray(
					rooms.propertyId,
					db
						.select({ id: properties.id })
						.from(properties)
						.where(eq(properties.landlordId, locals.session.staffLandlordId!))
				)
			);
		}
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
		// Giới hạn theo chủ trọ (dùng cho cổng /staff xem phòng) — chỉ phòng thuộc cơ sở của chủ trọ này
		if (landlordId) {
			conditions.push(
				inArray(
					rooms.propertyId,
					db
						.select({ id: properties.id })
						.from(properties)
						.where(eq(properties.landlordId, landlordId))
				)
			);
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

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const { propertyId, blockId, roomNumber, roomCode, roomType, floor, monthlyRent, area } = body;

		if (!propertyId || !roomNumber || !roomType || !monthlyRent) {
			return json({ error: 'Missing required room fields' }, { status: 400 });
		}
		if (!(await landlordOwnsProperty(auth.value, propertyId))) {
			return forbidden();
		}

		const canonicalRoomCode = normalizeRoomCodeForProperty(propertyId, roomCode || roomNumber);
		const nextRoomNumber =
			!roomCode && canonicalRoomCode ? canonicalRoomCode : String(roomNumber).trim();
		const nextRoomCode = canonicalRoomCode ?? (roomCode ? String(roomCode).trim() : null);

		const existing = await findDuplicateRoom(propertyId, nextRoomNumber, nextRoomCode);
		if (existing) {
			return json(
				{ error: `Phòng "${nextRoomNumber}" đã tồn tại trong căn ${nextRoomCode || existing.roomCode || existing.roomNumber}` },
				{ status: 400 }
			);
		}

		const room = await db.transaction(async (tx) => {
			// Create the room
			const r = (
				await tx
					.insert(rooms)
					.values({
						propertyId,
						blockId: blockId || null,
						roomNumber: nextRoomNumber,
						roomCode: nextRoomCode,
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

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const { id, action, ...data } = body;

		if (!id) {
			return json({ error: 'Missing room ID' }, { status: 400 });
		}
		if (!(await landlordOwnsRoom(auth.value, id))) {
			return forbidden();
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
			if (data.roomNumber !== undefined || data.roomCode !== undefined) {
				const currentRoom = await db.query.rooms.findFirst({
					where: eq(rooms.id, id),
					columns: { propertyId: true, roomNumber: true, roomCode: true }
				});
				if (!currentRoom) {
					return json({ error: 'Room not found' }, { status: 404 });
				}

				const submittedRoomNumber =
					data.roomNumber !== undefined ? String(data.roomNumber).trim() : currentRoom.roomNumber;
				const submittedRoomCode =
					data.roomCode !== undefined
						? data.roomCode
							? String(data.roomCode).trim()
							: null
						: currentRoom.roomCode;
				const canonicalRoomCode = normalizeRoomCodeForProperty(
					currentRoom.propertyId,
					submittedRoomCode || submittedRoomNumber
				);
				const nextRoomNumber =
					!submittedRoomCode && canonicalRoomCode ? canonicalRoomCode : submittedRoomNumber;
				const nextRoomCode = canonicalRoomCode ?? submittedRoomCode;

				const duplicate = await findDuplicateRoom(
					currentRoom.propertyId,
					nextRoomNumber,
					nextRoomCode,
					id
				);
				if (duplicate) {
					return json(
						{ error: `Phòng "${nextRoomNumber}" đã tồn tại trong căn ${nextRoomCode || duplicate.roomCode || duplicate.roomNumber}` },
						{ status: 400 }
					);
				}

				if (data.roomNumber !== undefined) updateData.roomNumber = nextRoomNumber;
				if (data.roomCode !== undefined) updateData.roomCode = nextRoomCode;
			}
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

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing room ID' }, { status: 400 });
		}
		if (!(await landlordOwnsRoom(auth.value, id))) {
			return forbidden();
		}

		await db.delete(rooms).where(eq(rooms.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
