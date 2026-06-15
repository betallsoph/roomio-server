import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { rooms, invoices, invoiceItems, meterReadings } from '$lib/server/db/schema';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { landlordId, propertyId, month, dueDate, readings } = body; // readings: { [roomId]: { [serviceId]: { prevValue, currValue } } }

		if (!landlordId || !propertyId || !month || !dueDate || !readings) {
			return json({ error: 'Missing required parameters' }, { status: 400 });
		}

		// Fetch all occupied rooms for this property
		const occupiedRooms = await db.query.rooms.findMany({
			where: and(eq(rooms.propertyId, propertyId), isNotNull(rooms.tenantId)),
			with: {
				tenant: { with: { user: true } },
				services: { with: { service: true } }
			}
		});

		if (occupiedRooms.length === 0) {
			return json(
				{ error: 'Không tìm thấy phòng có khách đang ở trong tòa nhà này' },
				{ status: 400 }
			);
		}

		const today = new Date().toISOString().split('T')[0];

		const createdInvoices = await db.transaction(async (tx) => {
			const results = [];

			for (const room of occupiedRooms) {
				if (!room.tenant) continue;

				const tenantName = room.tenant.user.name;
				const tenantPhone = room.tenant.user.phone;
				const roomReadings = readings[room.id] || {};

				const items = [];
				let totalServicesAmount = 0;

				// Add room rent item
				items.push({
					name: 'Tiền phòng',
					amount: room.monthlyRent,
					details: `Tiền thuê phòng tháng ${month.split('-')[1]}/${month.split('-')[0]}`
				});

				// Loop through each service configuration for this room
				for (const config of room.services) {
					if (!config.service.isActive) continue;

					const rate = config.customRate !== null ? config.customRate : config.service.defaultRate;
					let amount = 0;
					let details = '';

					if (config.service.type === 'METERED') {
						const serviceReading = roomReadings[config.serviceId] || { prevValue: 0, currValue: 0 };
						const prev = Number(serviceReading.prevValue) || 0;
						const curr = Number(serviceReading.currValue) || 0;
						const usage = curr - prev;
						amount = usage * rate;
						details = `Chỉ số: ${prev} -> ${curr} (${usage} ${config.service.name === 'Điện' ? 'kWh' : 'm³'}) x ${new Intl.NumberFormat('vi-VN').format(rate)}đ`;

						// Record this meter reading
						await tx.insert(meterReadings).values({
							roomId: room.id,
							serviceId: config.serviceId,
							month,
							prevValue: prev,
							currValue: curr,
							recordedAt: today
						});
					} else if (config.service.type === 'FLAT_ROOM') {
						amount = rate * config.quantity;
						details = `Phí cố định x ${config.quantity} phòng`;
					} else if (config.service.type === 'FLAT_PERSON') {
						amount = rate * config.quantity;
						details = `Đơn giá: ${new Intl.NumberFormat('vi-VN').format(rate)}đ x ${config.quantity} người`;
					} else if (config.service.type === 'FLAT_VEHICLE') {
						amount = rate * config.quantity;
						details = `Đơn giá: ${new Intl.NumberFormat('vi-VN').format(rate)}đ x ${config.quantity} xe`;
					}

					if (amount > 0) {
						items.push({
							name: config.service.name,
							amount,
							details
						});
						totalServicesAmount += amount;
					}
				}

				const totalAmount = room.monthlyRent + totalServicesAmount;

				// Generate Invoice ID
				const randomHex = Math.floor(1000 + Math.random() * 9000).toString();
				const invoiceId = `INV-${month.replace('-', '')}-${randomHex}`;

				// Create Invoice
				const inv = (
					await tx
						.insert(invoices)
						.values({
							id: invoiceId,
							roomId: room.id,
							roomNumber: room.roomNumber,
							tenantName,
							tenantPhone,
							month,
							rentAmount: room.monthlyRent,
							totalAmount,
							dueDate,
							status: 'pending',
							paidAmount: 0,
							createdAt: today,
							notes: `Hóa đơn tự động tháng ${month}`
						})
						.returning()
				)[0];

				// Create Invoice Items
				await tx.insert(invoiceItems).values(items.map((item) => ({ ...item, invoiceId: inv.id })));

				// Increment Room outstanding debt
				await tx
					.update(rooms)
					.set({
						status: 'debt',
						debtAmount: sql`coalesce(${rooms.debtAmount}, 0) + ${totalAmount}`
					})
					.where(eq(rooms.id, room.id));

				results.push(inv);
			}

			return results;
		});

		return json({ success: true, count: createdInvoices.length, invoices: createdInvoices });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

// Dữ liệu chuẩn bị cho màn tạo hóa đơn hàng loạt: phòng đang có khách,
// kèm chỉ số đã được duyệt (khách gửi + chủ chốt) của tháng để tự điền sẵn
export const GET: RequestHandler = async ({ url }) => {
	try {
		const propertyId = url.searchParams.get('propertyId');
		const month = url.searchParams.get('month');

		if (!propertyId || !month) {
			return json({ error: 'Missing propertyId or month' }, { status: 400 });
		}

		const occupiedRooms = await db.query.rooms.findMany({
			where: and(eq(rooms.propertyId, propertyId), isNotNull(rooms.tenantId)),
			with: {
				tenant: { with: { user: { columns: { name: true, phone: true } } } },
				services: { with: { service: true } }
			}
		});

		const roomIds = occupiedRooms.map((r) => r.id);

		// Chỉ số của tháng cần lập hóa đơn (mọi trạng thái, để UI hiển thị cả bản chờ duyệt)
		const monthReadings = roomIds.length
			? await db
					.select()
					.from(meterReadings)
					.where(and(inArray(meterReadings.roomId, roomIds), eq(meterReadings.month, month)))
			: [];

		// Chỉ số đã duyệt gần nhất của các tháng trước — dùng làm chỉ số đầu kỳ
		const previousApproved = roomIds.length
			? await db
					.select()
					.from(meterReadings)
					.where(and(inArray(meterReadings.roomId, roomIds), eq(meterReadings.status, 'approved')))
					.orderBy(desc(meterReadings.month))
			: [];

		const readings: Record<string, Record<string, unknown>> = {};
		for (const r of monthReadings) {
			readings[r.roomId] = readings[r.roomId] || {};
			readings[r.roomId][r.serviceId] = {
				prevValue: r.prevValue,
				currValue: r.currValue,
				status: r.status,
				photoUrl: r.photoUrl,
				isAnomalous: r.isAnomalous
			};
		}

		const prevValues: Record<string, Record<string, number>> = {};
		for (const r of previousApproved) {
			if (r.month >= month) continue;
			prevValues[r.roomId] = prevValues[r.roomId] || {};
			if (prevValues[r.roomId][r.serviceId] === undefined) {
				prevValues[r.roomId][r.serviceId] = r.currValue;
			}
		}

		return json({ rooms: occupiedRooms, readings, prevValues });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
