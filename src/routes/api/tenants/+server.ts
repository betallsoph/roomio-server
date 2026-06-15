import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	users,
	tenantProfiles,
	rooms,
	properties,
	services,
	meterReadings,
	contracts
} from '$lib/server/db/schema';
import { and, eq, inArray, isNotNull, like, or } from 'drizzle-orm';
import crypto from 'crypto';

function hashPassword(password: string) {
	return crypto.createHash('sha256').update(password).digest('hex');
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');

		if (!landlordId) {
			return json({ error: 'Missing landlord ID' }, { status: 400 });
		}

		// Tenants that currently occupy a room in one of the landlord's properties
		const tenantIdsSubquery = db
			.select({ id: rooms.tenantId })
			.from(rooms)
			.innerJoin(properties, eq(rooms.propertyId, properties.id))
			.where(and(eq(properties.landlordId, landlordId), isNotNull(rooms.tenantId)));

		const tenants = await db.query.tenantProfiles.findMany({
			where: inArray(tenantProfiles.id, tenantIdsSubquery),
			with: {
				user: {
					columns: { id: true, name: true, email: true, phone: true }
				},
				rooms: {
					with: {
						property: true,
						block: true
					}
				}
			}
		});

		tenants.sort((a, b) => a.user.name.localeCompare(b.user.name, 'vi'));

		return json(tenants);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const {
			email,
			phone,
			password,
			name,
			roomId,
			idNumber,
			moveInDate,
			deposit,
			notes,
			initialElectricity,
			initialWater
		} = body;

		if (
			!email ||
			!phone ||
			!password ||
			!name ||
			!roomId ||
			!idNumber ||
			!moveInDate ||
			deposit === undefined
		) {
			return json({ error: 'Thiếu thông tin khách thuê bắt buộc' }, { status: 400 });
		}

		// 1. Check if user already exists
		const existingUser = await db.query.users.findFirst({
			where: or(eq(users.email, email), eq(users.phone, phone))
		});

		const tenant = await db.transaction(async (tx) => {
			const user =
				existingUser ??
				(
					await tx
						.insert(users)
						.values({ email, phone, passwordHash: hashPassword(password), name, role: 'TENANT' })
						.returning()
				)[0];

			// 2. Check if TenantProfile exists
			let tenantProfile = (
				await tx.select().from(tenantProfiles).where(eq(tenantProfiles.userId, user.id))
			)[0];

			if (!tenantProfile) {
				tenantProfile = (
					await tx
						.insert(tenantProfiles)
						.values({ userId: user.id, idNumber, moveInDate, deposit: Number(deposit), notes })
						.returning()
				)[0];
			} else {
				// Update details if profile already exists
				tenantProfile = (
					await tx
						.update(tenantProfiles)
						.set({ idNumber, moveInDate, deposit: Number(deposit), notes })
						.where(eq(tenantProfiles.id, tenantProfile.id))
						.returning()
				)[0];
			}

			// 3. Link room to tenant
			const room = (
				await tx
					.update(rooms)
					.set({
						tenantId: tenantProfile.id,
						status: 'paid', // Mark as active/paid initially
						debtAmount: 0
					})
					.where(eq(rooms.id, roomId))
					.returning()
			)[0];

			const property = (
				await tx
					.select({ landlordId: properties.landlordId })
					.from(properties)
					.where(eq(properties.id, room.propertyId))
			)[0];

			// 4. Record initial meters
			const checkInMonth = moveInDate.slice(0, 7); // "YYYY-MM"
			const today = new Date().toISOString().split('T')[0];

			if (property) {
				// Find electricity & water services for the landlord
				const electricityService = (
					await tx
						.select()
						.from(services)
						.where(and(eq(services.landlordId, property.landlordId), like(services.name, '%Điện%')))
				)[0];
				const waterService = (
					await tx
						.select()
						.from(services)
						.where(and(eq(services.landlordId, property.landlordId), like(services.name, '%Nước%')))
				)[0];

				if (electricityService && initialElectricity !== undefined) {
					await tx.insert(meterReadings).values({
						roomId: room.id,
						serviceId: electricityService.id,
						month: checkInMonth,
						prevValue: Number(initialElectricity),
						currValue: Number(initialElectricity),
						recordedAt: today
					});
				}

				if (waterService && initialWater !== undefined) {
					await tx.insert(meterReadings).values({
						roomId: room.id,
						serviceId: waterService.id,
						month: checkInMonth,
						prevValue: Number(initialWater),
						currValue: Number(initialWater),
						recordedAt: today
					});
				}
			}

			// 5. Create a 12-month rental contract by default
			const start = new Date(moveInDate);
			const end = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
			await tx.insert(contracts).values({
				tenantId: tenantProfile.id,
				roomId: room.id,
				startDate: moveInDate,
				endDate: end.toISOString().split('T')[0],
				monthlyRent: room.monthlyRent,
				deposit: Number(deposit),
				notes: notes || null,
				status: 'active'
			});

			return tenantProfile;
		});

		const fullTenant = await db.query.tenantProfiles.findFirst({
			where: eq(tenantProfiles.id, tenant.id),
			with: {
				user: true,
				rooms: {
					with: { property: true }
				}
			}
		});

		return json(fullTenant);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { id, idNumber, idFrontImage, idBackImage, vehicleImage, checkInImage } = body;

		if (!id) {
			return json({ error: 'Missing tenant profile ID' }, { status: 400 });
		}

		// Khách thuê chỉ được cập nhật hồ sơ của chính mình
		if (locals.session?.role === 'TENANT' && id !== locals.session.tenantProfileId) {
			return json({ error: 'Không có quyền cập nhật hồ sơ này' }, { status: 403 });
		}

		const updateData: Record<string, unknown> = {};
		if (idNumber !== undefined) updateData.idNumber = idNumber;
		if (idFrontImage !== undefined) updateData.idFrontImage = idFrontImage;
		if (idBackImage !== undefined) updateData.idBackImage = idBackImage;
		if (vehicleImage !== undefined) updateData.vehicleImage = vehicleImage;
		if (checkInImage !== undefined) updateData.checkInImage = checkInImage;

		if (Object.keys(updateData).length > 0) {
			await db.update(tenantProfiles).set(updateData).where(eq(tenantProfiles.id, id));
		}

		const updated = await db.query.tenantProfiles.findFirst({
			where: eq(tenantProfiles.id, id),
			with: {
				user: true,
				rooms: {
					with: { property: true }
				}
			}
		});

		return json(updated);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
