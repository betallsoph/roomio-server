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
	landlordProfiles
} from '$lib/server/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { normalizeRoomTextKey } from '$lib/server/room-code';
import { getPaymentAccountForLandlord } from '$lib/server/payment-accounts';
import { requireLandlordActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	unauthenticatedError
} from '$lib/server/authorization/errors';
import { isTenancyDualWriteEnabled } from '$lib/server/env';
import { endActiveTenancyForRoom, hasActiveTenancyForRoom } from '$lib/server/tenancies/service';
import { isTenancyServiceError, toTenancyErrorBody } from '$lib/server/tenancies/state';
import {
	SUBSCRIPTION_TIERS,
	pricingGroupForRentalType,
	subscriptionTierLimits,
	type SubscriptionTier
} from '$lib/server/subscription-pricing';
import { ROOM_DETAIL_WITH, toRoomDto, toTenantRoomSummaryDto } from '$lib/server/dto/rooms';
import {
	assertBlockInScopedProperty,
	deleteRoomAssetScoped,
	deleteRoomScoped,
	listRoomsForActor,
	propertyScopeErrorToResponse,
	requireLandlordMutationActor,
	requireOperationalActor,
	requireScopedProperty,
	requireScopedRoom,
	updateRoomAssetScoped,
	updateRoomScoped,
	updateRoomServiceConfigsScoped
} from '$lib/server/property-scope';
import { isTenantActor } from '$lib/server/property-scope/actor';

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
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const result = await listRoomsForActor(db, actorResult.actor, {
			propertyId: url.searchParams.get('propertyId'),
			blockId: url.searchParams.get('blockId'),
			status: url.searchParams.get('status')
		});

		if (isTenantActor(actorResult.actor)) {
			return json(result.map(toTenantRoomSummaryDto));
		}
		return json(result.map(toRoomDto));
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
			area,
			paymentAccountId
		} = body;

		if (!propertyId || !roomNumber || !roomType || !monthlyRent) {
			return json({ error: 'Missing required room fields' }, { status: 400 });
		}

		const property = await requireScopedProperty(db, actorResult.actor, propertyId);

		const selectedPaymentAccount = await getPaymentAccountForLandlord(
			actorResult.actor.landlordId,
			paymentAccountId || null
		);
		if (!selectedPaymentAccount.isActive) {
			return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
		}

		const nextRoomNumber = String(roomNumber).trim();
		let nextRoomCode = roomCode ? String(roomCode).trim() : null;
		const nextBlockId = blockId || null;
		const nextFloor =
			floor !== undefined && floor !== null && floor !== '' ? normalizeFloor(floor) : null;

		if (property.rentalType === 'APARTMENT') {
			if (!nextBlockId || nextFloor === null) {
				return json({ error: 'Chung cư cần chọn block và nhập tầng' }, { status: 400 });
			}
			await assertBlockInScopedProperty(db, actorResult.actor, propertyId, nextBlockId);
			const apartmentUnit = normalizeApartmentUnit(unitNumber || roomCode);
			if (!apartmentUnit) {
				return json({ error: 'Chung cư cần nhập số căn' }, { status: 400 });
			}
			nextRoomCode = apartmentUnit;
		} else if (nextBlockId) {
			await assertBlockInScopedProperty(db, actorResult.actor, propertyId, nextBlockId);
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

		const createResult = await db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${actorResult.actor.landlordId}))`
			);
			const profile = (
				await tx
					.select({
						subscriptionType: landlordProfiles.subscriptionType,
						subValidUntil: landlordProfiles.subValidUntil,
						standardLimit: landlordProfiles.subscribedStandardRoomLimit,
						colivingLimit: landlordProfiles.subscribedColivingRoomLimit
					})
					.from(landlordProfiles)
					.where(eq(landlordProfiles.id, actorResult.actor.landlordId))
			)[0];
			const tier = SUBSCRIPTION_TIERS.includes(profile?.subscriptionType as SubscriptionTier)
				? (profile.subscriptionType as SubscriptionTier)
				: 'FREE';
			if (tier !== 'FREE' && profile?.subValidUntil && profile.subValidUntil <= new Date()) {
				return { error: 'Gói Roomio đã hết hạn; vui lòng gia hạn trước khi thêm phòng' };
			}

			const roomCounts = await tx
				.select({ rentalType: properties.rentalType, count: sql<number>`count(${rooms.id})` })
				.from(properties)
				.leftJoin(rooms, eq(rooms.propertyId, properties.id))
				.where(eq(properties.landlordId, actorResult.actor.landlordId))
				.groupBy(properties.rentalType);
			const standardCount = roomCounts
				.filter((row) => pricingGroupForRentalType(row.rentalType) === 'STANDARD')
				.reduce((sum, row) => sum + Number(row.count), 0);
			const colivingCount = roomCounts
				.filter((row) => pricingGroupForRentalType(row.rentalType) === 'COLIVING')
				.reduce((sum, row) => sum + Number(row.count), 0);
			const totalCount = standardCount + colivingCount;
			const limits = subscriptionTierLimits(tier);
			if (limits.maxRooms !== null && totalCount >= limits.maxRooms) {
				return { error: `Gói hiện tại chỉ cho phép tối đa ${limits.maxRooms} phòng` };
			}
			const isColivingGroup = pricingGroupForRentalType(property.rentalType) === 'COLIVING';
			const groupCount = isColivingGroup ? colivingCount : standardCount;
			const groupLimit = isColivingGroup ? profile?.colivingLimit : profile?.standardLimit;
			if (groupLimit !== null && groupLimit !== undefined && groupCount >= groupLimit) {
				return {
					error: `Đã đạt hạn mức ${groupLimit} đơn vị ${isColivingGroup ? 'share phòng chung cư / co-living' : 'trọ / CHDV / Sleepbox / nguyên căn'} đã đăng ký`
				};
			}

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
						paymentAccountId: selectedPaymentAccount.id,
						debtAmount: 0
					})
					.returning()
			)[0];

			const activeServices = await tx
				.select()
				.from(services)
				.where(
					and(eq(services.landlordId, actorResult.actor.landlordId), eq(services.isActive, true))
				);
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

			return { room: r };
		});
		if ('error' in createResult) return json({ error: createResult.error }, { status: 403 });
		const room = createResult.room;

		const fullRoom = await db.query.rooms.findFirst({
			where: eq(rooms.id, room.id),
			with: {
				...ROOM_DETAIL_WITH,
				meterReadings: {
					...ROOM_DETAIL_WITH.meterReadings,
					orderBy: desc(meterReadings.month)
				}
			}
		});

		return json(fullRoom ? toRoomDto(fullRoom) : null);
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

async function checkoutWithTenancyService(
	locals: App.Locals,
	roomId: string,
	endDate: string | null
): Promise<Response> {
	if (!locals.actor) {
		return authorizationErrorToResponse(unauthenticatedError());
	}
	const actorResult = requireLandlordActor(locals.actor);
	if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);

	try {
		const ended = await endActiveTenancyForRoom(
			db,
			actorResult.value,
			{ roomId, endDate },
			{ requestId: locals.requestId }
		);
		return json({ tenancy: ended.tenancy, room: { id: roomId } });
	} catch (error) {
		if (isTenancyServiceError(error)) {
			return json(toTenancyErrorBody(error, locals.requestId), { status: error.status });
		}
		throw error;
	}
}

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { id, action, ...data } = body ?? {};

		if (action === 'checkout' && isTenancyDualWriteEnabled()) {
			if (!id) return json({ error: 'Missing room ID' }, { status: 400 });
			return await checkoutWithTenancyService(locals, String(id), data?.endDate ?? null);
		}

		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		if (!id) {
			return json({ error: 'Missing room ID' }, { status: 400 });
		}

		// Every PUT path assembles a room DTO — scope before mutations and before response fetch.
		await requireScopedRoom(db, actorResult.actor, String(id));

		if (action === 'updateMeters') {
			return json({ error: 'Meter updates belong on /api/meter-readings' }, { status: 400 });
		}

		if (action === 'updateAsset') {
			const { assetId, name, code, status, notes } = data;
			if (!name) {
				return json({ error: 'Missing asset name' }, { status: 400 });
			}
			await updateRoomAssetScoped(db, actorResult.actor, {
				roomId: String(id),
				assetId,
				name,
				code,
				status,
				notes
			});
		} else if (action === 'deleteAsset') {
			const { assetId } = data;
			if (!assetId) {
				return json({ error: 'Missing asset ID' }, { status: 400 });
			}
			await deleteRoomAssetScoped(db, actorResult.actor, {
				roomId: String(id),
				assetId: String(assetId)
			});
		} else if (action === 'updateServiceConfig') {
			const { configs } = data;
			if (configs && Array.isArray(configs)) {
				await updateRoomServiceConfigsScoped(db, actorResult.actor, String(id), configs);
			}
		} else if (action === 'checkout') {
			if (await hasActiveTenancyForRoom(db, id)) {
				return await checkoutWithTenancyService(locals, String(id), data?.endDate ?? null);
			}
			await updateRoomScoped(db, actorResult.actor, String(id), {
				status: 'empty',
				tenantId: null,
				debtAmount: 0
			});
		} else {
			const updateData: Record<string, unknown> = {};
			if (
				data.roomNumber !== undefined ||
				data.roomCode !== undefined ||
				data.unitNumber !== undefined ||
				data.blockId !== undefined ||
				data.floor !== undefined
			) {
				const room = await requireScopedRoom(db, actorResult.actor, String(id));

				const property = await db.query.properties.findFirst({
					where: eq(properties.id, room.propertyId),
					columns: { rentalType: true }
				});
				if (!property) {
					return json({ error: 'Property not found' }, { status: 404 });
				}

				const submittedRoomNumber =
					data.roomNumber !== undefined ? String(data.roomNumber).trim() : room.roomNumber;
				let submittedRoomCode =
					data.roomCode !== undefined
						? data.roomCode
							? String(data.roomCode).trim()
							: null
						: room.roomCode;
				const submittedBlockId = data.blockId !== undefined ? data.blockId || null : room.blockId;
				const submittedFloor =
					data.floor !== undefined && data.floor !== null && data.floor !== ''
						? normalizeFloor(data.floor)
						: room.floor;

				if (property.rentalType === 'APARTMENT') {
					if (!submittedBlockId || submittedFloor === null) {
						return json({ error: 'Chung cư cần chọn block và nhập tầng' }, { status: 400 });
					}
					await assertBlockInScopedProperty(
						db,
						actorResult.actor,
						room.propertyId,
						submittedBlockId
					);
					const apartmentUnit = normalizeApartmentUnit(data.unitNumber || submittedRoomCode);
					if (!apartmentUnit) {
						return json({ error: 'Chung cư cần nhập số căn' }, { status: 400 });
					}
					submittedRoomCode = apartmentUnit;
				} else if (submittedBlockId) {
					await assertBlockInScopedProperty(
						db,
						actorResult.actor,
						room.propertyId,
						submittedBlockId
					);
				}

				const duplicate = await findDuplicateRoom(
					room.propertyId,
					submittedRoomNumber,
					submittedRoomCode,
					submittedBlockId,
					submittedFloor,
					id
				);
				if (duplicate) {
					return json(
						{
							error: `Phòng "${submittedRoomNumber}" đã tồn tại trong căn ${submittedRoomCode || duplicate.roomCode || duplicate.roomNumber}`
						},
						{ status: 400 }
					);
				}

				if (data.roomNumber !== undefined) updateData.roomNumber = submittedRoomNumber;
				if (
					data.roomCode !== undefined ||
					data.unitNumber !== undefined ||
					(property.rentalType === 'APARTMENT' &&
						(data.blockId !== undefined || data.floor !== undefined))
				) {
					updateData.roomCode = submittedRoomCode;
				}
			}
			if (data.roomType !== undefined) updateData.roomType = data.roomType;
			if (data.floor !== undefined) updateData.floor = normalizeFloor(data.floor);
			if (data.monthlyRent !== undefined) updateData.monthlyRent = Number(data.monthlyRent);
			if (data.area !== undefined) updateData.area = Number(data.area);
			if (data.status !== undefined) updateData.status = data.status;
			if (data.debtAmount !== undefined) updateData.debtAmount = Number(data.debtAmount);
			if (data.blockId !== undefined) updateData.blockId = data.blockId || null;
			if (data.paymentAccountId !== undefined) {
				const selectedPaymentAccount = await getPaymentAccountForLandlord(
					actorResult.actor.landlordId,
					data.paymentAccountId || null
				);
				if (!selectedPaymentAccount.isActive) {
					return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
				}
				updateData.paymentAccountId = selectedPaymentAccount.id;
			}

			if (Object.keys(updateData).length > 0) {
				await updateRoomScoped(db, actorResult.actor, String(id), updateData);
			}
		}

		const updatedRoom = await db.query.rooms.findFirst({
			where: eq(rooms.id, id),
			with: {
				...ROOM_DETAIL_WITH,
				meterReadings: {
					...ROOM_DETAIL_WITH.meterReadings,
					orderBy: desc(meterReadings.month)
				}
			}
		});

		return json(updatedRoom ? toRoomDto(updatedRoom) : null);
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

		await deleteRoomScoped(db, actorResult.actor, id);
		return json({ success: true });
	} catch (error) {
		const scoped = propertyScopeErrorToResponse(error);
		if (scoped) return scoped;
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
