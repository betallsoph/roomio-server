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
import { normalizeRoomTextKey } from '$lib/server/room-code';

function roomUnitKey(
	roomNumber: string,
	roomCode: string | null,
	blockId: string | null,
	floor: number | null
) {
	return [blockId || '', floor ?? '', normalizeRoomTextKey(roomCode || roomNumber)].join('|');
}

function normalizeApartmentUnit(value: unknown) {
	const raw = String(value ?? '')
		.trim()
		.toUpperCase()
		.replace(/\s+/g, '');
	if (!raw) return '';
	return raw;
}

function normalizeFloor(value: unknown) {
	const floorNumber = Number(value);
	if (!Number.isFinite(floorNumber)) return null;
	return Math.trunc(floorNumber);
}

// Một MÃ CĂN có thể chứa NHIỀU PHÒNG (cho thuê theo phòng/giường). Vì vậy chỉ coi là TRÙNG khi
// CÙNG mã căn VÀ CÙNG tên phòng — không chặn việc thêm phòng mới vào căn đã tồn tại.
async function findDuplicateRoom(
	propertyId: string,
	roomNumber: string,
	roomCode: string | null,
	blockId: string | null,
	floor: number | null,
	excludeRoomId?: string
) {
	const targetUnit = roomUnitKey(roomNumber, roomCode, blockId, floor);
	const targetName = normalizeRoomTextKey(roomNumber);
	if (!targetUnit && !targetName) return undefined;

	const propertyRooms = await db.query.rooms.findMany({
		where: eq(rooms.propertyId, propertyId),
		columns: { id: true, roomNumber: true, roomCode: true, blockId: true, floor: true }
	});

	return propertyRooms.find((room) => {
		if (excludeRoomId && room.id === excludeRoomId) return false;
		const existingUnit = roomUnitKey(room.roomNumber, room.roomCode, room.blockId, room.floor);
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
				block: true,
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
		const {
			propertyId,
			blockId,
			roomNumber,
			roomCode,
			unitNumber,
			roomType,
			floor,
			monthlyRent,
			area
		} = body;

		if (!propertyId || !roomNumber || !roomType || !monthlyRent) {
			return json({ error: 'Missing required room fields' }, { status: 400 });
		}
		if (!(await landlordOwnsProperty(auth.value, propertyId))) {
			return forbidden();
		}

		const property = await db.query.properties.findFirst({
			where: eq(properties.id, propertyId),
			with: { blocks: true }
		});
		if (!property) {
			return json({ error: 'Property not found' }, { status: 404 });
		}

		const nextRoomNumber = String(roomNumber).trim();
		let nextRoomCode = roomCode ? String(roomCode).trim() : null;
		let nextBlockId = blockId || null;
		const nextFloor =
			floor !== undefined && floor !== null && floor !== '' ? normalizeFloor(floor) : null;

		if (property.rentalType === 'APARTMENT') {
			if (!nextBlockId || nextFloor === null) {
				return json({ error: 'Chung cư cần chọn block và nhập tầng' }, { status: 400 });
			}
			const block = property.blocks.find((item) => item.id === nextBlockId);
			if (!block) {
				return json({ error: 'Block không thuộc tòa nhà đã chọn' }, { status: 400 });
			}
			const apartmentUnit = normalizeApartmentUnit(unitNumber || roomCode);
			if (!apartmentUnit) {
				return json({ error: 'Chung cư cần nhập số căn' }, { status: 400 });
			}
			nextRoomCode = apartmentUnit;
		} else if (nextBlockId) {
			const block = property.blocks.find((item) => item.id === nextBlockId);
			if (!block) {
				return json({ error: 'Khu/dãy không thuộc tòa nhà đã chọn' }, { status: 400 });
			}
		}

		const existing = await findDuplicateRoom(
			propertyId,
			nextRoomNumber,
			nextRoomCode,
			nextBlockId,
			nextFloor
		);
		if (existing) {
			return json(
				{
					error: `Phòng "${nextRoomNumber}" đã tồn tại trong căn ${nextRoomCode || existing.roomCode || existing.roomNumber}`
				},
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
						blockId: nextBlockId,
						roomNumber: nextRoomNumber,
						roomCode: nextRoomCode,
						roomType,
						floor: nextFloor,
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
			if (
				data.roomNumber !== undefined ||
				data.roomCode !== undefined ||
				data.unitNumber !== undefined ||
				data.blockId !== undefined ||
				data.floor !== undefined
			) {
				const currentRoom = await db.query.rooms.findFirst({
					where: eq(rooms.id, id),
					columns: {
						propertyId: true,
						roomNumber: true,
						roomCode: true,
						blockId: true,
						floor: true
					}
				});
				if (!currentRoom) {
					return json({ error: 'Room not found' }, { status: 404 });
				}

				const property = await db.query.properties.findFirst({
					where: eq(properties.id, currentRoom.propertyId),
					with: { blocks: true }
				});
				if (!property) {
					return json({ error: 'Property not found' }, { status: 404 });
				}

				const submittedRoomNumber =
					data.roomNumber !== undefined ? String(data.roomNumber).trim() : currentRoom.roomNumber;
				let submittedRoomCode =
					data.roomCode !== undefined
						? data.roomCode
							? String(data.roomCode).trim()
							: null
						: currentRoom.roomCode;
				const submittedBlockId =
					data.blockId !== undefined ? data.blockId || null : currentRoom.blockId;
				const submittedFloor =
					data.floor !== undefined && data.floor !== null && data.floor !== ''
						? normalizeFloor(data.floor)
						: currentRoom.floor;

				if (property.rentalType === 'APARTMENT') {
					if (!submittedBlockId || submittedFloor === null) {
						return json({ error: 'Chung cư cần chọn block và nhập tầng' }, { status: 400 });
					}
					const block = property.blocks.find((item) => item.id === submittedBlockId);
					if (!block) {
						return json({ error: 'Block không thuộc tòa nhà đã chọn' }, { status: 400 });
					}
					const apartmentUnit = normalizeApartmentUnit(data.unitNumber || submittedRoomCode);
					if (!apartmentUnit) {
						return json({ error: 'Chung cư cần nhập số căn' }, { status: 400 });
					}
					submittedRoomCode = apartmentUnit;
				} else if (submittedBlockId) {
					const block = property.blocks.find((item) => item.id === submittedBlockId);
					if (!block) {
						return json({ error: 'Khu/dãy không thuộc tòa nhà đã chọn' }, { status: 400 });
					}
				}

				const nextRoomNumber = submittedRoomNumber;
				const nextRoomCode = submittedRoomCode;

				const duplicate = await findDuplicateRoom(
					currentRoom.propertyId,
					nextRoomNumber,
					nextRoomCode,
					submittedBlockId,
					submittedFloor,
					id
				);
				if (duplicate) {
					return json(
						{
							error: `Phòng "${nextRoomNumber}" đã tồn tại trong căn ${nextRoomCode || duplicate.roomCode || duplicate.roomNumber}`
						},
						{ status: 400 }
					);
				}

				if (data.roomNumber !== undefined) updateData.roomNumber = nextRoomNumber;
				if (
					data.roomCode !== undefined ||
					data.unitNumber !== undefined ||
					(property.rentalType === 'APARTMENT' &&
						(data.blockId !== undefined || data.floor !== undefined))
				) {
					updateData.roomCode = nextRoomCode;
				}
			}
			if (data.roomType !== undefined) updateData.roomType = data.roomType;
			if (data.floor !== undefined) updateData.floor = normalizeFloor(data.floor);
			if (data.monthlyRent !== undefined) updateData.monthlyRent = Number(data.monthlyRent);
			if (data.area !== undefined) updateData.area = Number(data.area);
			if (data.status !== undefined) updateData.status = data.status;
			if (data.debtAmount !== undefined) updateData.debtAmount = Number(data.debtAmount);
			if (data.blockId !== undefined) updateData.blockId = data.blockId || null;

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
