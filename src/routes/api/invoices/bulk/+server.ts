import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	contracts,
	invoices,
	invoiceItems,
	meterReadings,
	paymentAccounts,
	rooms
} from '$lib/server/db/schema';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { forbidden, landlordOwnsProperty, requireLandlord } from '$lib/server/authz';
import { toBulkInvoicePrepRoomDto, toInvoiceDto } from '$lib/server/dto/invoice';
import { getPaymentAccountForLandlord } from '$lib/server/payment-accounts';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;

		const body = await request.json();
		const {
			propertyId,
			month,
			dueDate,
			readings,
			manualAmounts = {},
			adjustments = {}, // { [roomId]: [{ name, amount }] } — phụ thu/giảm 1 lần (amount âm = giảm)
			prorate = {}, // { [roomId]: 0..1 } — tỉ lệ tiền phòng cho khách vào/ra giữa tháng
			roomIds, // chỉ lập cho các phòng này (smart bulk duyệt phần sẵn sàng); bỏ trống = làm hết
			paymentAccountId
		} = body; // readings: { [roomId]: { [serviceId]: { prevValue, currValue } } }

		if (!landlordId || !propertyId || !month || !dueDate || !readings) {
			return json({ error: 'Missing required parameters' }, { status: 400 });
		}
		if (!(await landlordOwnsProperty(landlordId, propertyId))) {
			return forbidden();
		}
		const defaultPaymentAccount = await getPaymentAccountForLandlord(
			landlordId,
			paymentAccountId || null
		);
		if (!defaultPaymentAccount.isActive) {
			return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
		}

		// Fetch all occupied rooms for this property
		const occupiedRooms = await db.query.rooms.findMany({
			where: and(eq(rooms.propertyId, propertyId), isNotNull(rooms.tenantId)),
			with: {
				tenant: { with: { user: true } },
				services: { with: { service: true } },
				paymentAccount: true
			}
		});

		if (occupiedRooms.length === 0) {
			return json(
				{ error: 'Không tìm thấy phòng có khách đang ở trong tòa nhà này' },
				{ status: 400 }
			);
		}

		// Chỉ lập cho các phòng được chọn (smart bulk: 'duyệt phần sẵn sàng'); bỏ trống = làm hết như cũ
		const targetRoomIds =
			Array.isArray(roomIds) && roomIds.length ? new Set(roomIds.map(String)) : null;
		const roomsToInvoice = targetRoomIds
			? occupiedRooms.filter((r) => targetRoomIds.has(r.id))
			: occupiedRooms;

		const today = new Date().toISOString().split('T')[0];

		const createdInvoices = await db.transaction(async (tx) => {
			const results = [];

			for (const room of roomsToInvoice) {
				if (!room.tenant) continue;

				const existingInvoice = await tx.query.invoices.findFirst({
					where: and(eq(invoices.roomId, room.id), eq(invoices.month, month)),
					columns: { id: true }
				});
				if (existingInvoice) continue;

				const tenantName = room.tenant.user.name;
				const tenantPhone = room.tenant.user.phone;
				const roomReadings = readings[room.id] || {};
				const roomManualAmounts = manualAmounts[room.id] || {};
				const activeContract = await tx.query.contracts.findFirst({
					where: and(eq(contracts.roomId, room.id), eq(contracts.status, 'active')),
					columns: { paymentAccountId: true },
					orderBy: desc(contracts.createdAt)
				});
				const selectedPaymentAccountId =
					paymentAccountId ||
					activeContract?.paymentAccountId ||
					room.paymentAccountId ||
					defaultPaymentAccount.id;
				const selectedPaymentAccount = await tx.query.paymentAccounts.findFirst({
					where: and(
						eq(paymentAccounts.id, selectedPaymentAccountId),
						eq(paymentAccounts.landlordId, landlordId)
					)
				});
				if (!selectedPaymentAccount) {
					throw new Error(`Không tìm thấy tài khoản nhận tiền cho phòng ${room.roomNumber}`);
				}
				if (!selectedPaymentAccount.isActive) {
					throw new Error(`Tài khoản nhận tiền của phòng ${room.roomNumber} đã tắt`);
				}

				const items = [];
				let totalServicesAmount = 0;

				// Tiền phòng — hỗ trợ prorate cho khách vào/ra giữa tháng: prorate[roomId] = tỉ lệ 0..1
				const rentFactorRaw = Number((prorate as Record<string, unknown>)?.[room.id]);
				const rentFactor =
					Number.isFinite(rentFactorRaw) && rentFactorRaw > 0 && rentFactorRaw < 1
						? rentFactorRaw
						: 1;
				const rentAmount = Math.round(room.monthlyRent * rentFactor);
				items.push({
					name: 'Tiền phòng',
					amount: rentAmount,
					details:
						rentFactor < 1
							? `Tiền thuê tháng ${month.split('-')[1]}/${month.split('-')[0]} (tính ${Math.round(rentFactor * 100)}%)`
							: `Tiền thuê phòng tháng ${month.split('-')[1]}/${month.split('-')[0]}`
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

						// Ghi nhận chỉ số (upsert theo phòng+dịch vụ+tháng, tránh trùng bản khách đã gửi/duyệt)
						const existingReading = await tx.query.meterReadings.findFirst({
							where: and(
								eq(meterReadings.roomId, room.id),
								eq(meterReadings.serviceId, config.serviceId),
								eq(meterReadings.month, month)
							),
							columns: { id: true }
						});
						if (existingReading) {
							await tx
								.update(meterReadings)
								.set({ prevValue: prev, currValue: curr, status: 'approved' })
								.where(eq(meterReadings.id, existingReading.id));
						} else {
							await tx.insert(meterReadings).values({
								roomId: room.id,
								serviceId: config.serviceId,
								month,
								prevValue: prev,
								currValue: curr,
								recordedAt: today,
								status: 'approved'
							});
						}
					} else if (config.service.type === 'FLAT_ROOM') {
						amount = rate * config.quantity;
						details = `Phí cố định x ${config.quantity} phòng`;
					} else if (config.service.type === 'FLAT_PERSON') {
						amount = rate * config.quantity;
						details = `Đơn giá: ${new Intl.NumberFormat('vi-VN').format(rate)}đ x ${config.quantity} người`;
					} else if (config.service.type === 'FLAT_VEHICLE') {
						amount = rate * config.quantity;
						details = `Đơn giá: ${new Intl.NumberFormat('vi-VN').format(rate)}đ x ${config.quantity} xe`;
					} else if (config.service.type === 'MANUAL_AMOUNT') {
						if (roomManualAmounts[config.serviceId] === undefined) {
							throw new Error(`Thiếu số tiền ${config.service.name} cho phòng ${room.roomNumber}`);
						}
						amount = Number(roomManualAmounts[config.serviceId]);
						if (!Number.isFinite(amount) || amount < 0) {
							throw new Error(
								`Số tiền ${config.service.name} của phòng ${room.roomNumber} không hợp lệ`
							);
						}
						details = `Khoản tự nhập tháng ${month}`;
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

				// Phụ thu / giảm 1 lần: adjustments[roomId] = [{ name, amount }] (amount âm = giảm)
				const roomAdjustments = Array.isArray((adjustments as Record<string, unknown>)?.[room.id])
					? (adjustments as Record<string, { name?: unknown; amount?: unknown }[]>)[room.id]
					: [];
				let adjustmentsTotal = 0;
				for (const adj of roomAdjustments) {
					const name = typeof adj?.name === 'string' ? adj.name.trim() : '';
					const amt = Number(adj?.amount);
					if (!name || !Number.isFinite(amt) || amt === 0) continue;
					items.push({ name, amount: amt, details: 'Điều chỉnh 1 lần' });
					adjustmentsTotal += amt;
				}

				const totalAmount = rentAmount + totalServicesAmount + adjustmentsTotal;
				if (totalAmount <= 0) {
					throw new Error(`Tổng tiền hóa đơn phòng ${room.roomNumber} phải lớn hơn 0`);
				}

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
							rentAmount,
							totalAmount,
							dueDate,
							status: 'pending',
							paidAmount: 0,
							paymentAccountId: selectedPaymentAccount.id,
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

		return json({
			success: true,
			count: createdInvoices.length,
			invoices: createdInvoices.map(toInvoiceDto)
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

// Dữ liệu chuẩn bị cho màn tạo hóa đơn hàng loạt: phòng đang có khách,
// kèm chỉ số đã được duyệt (khách gửi + chủ chốt) của tháng để tự điền sẵn
export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const propertyId = url.searchParams.get('propertyId');
		const month = url.searchParams.get('month');

		if (!propertyId || !month) {
			return json({ error: 'Missing propertyId or month' }, { status: 400 });
		}
		if (!(await landlordOwnsProperty(auth.value, propertyId))) {
			return forbidden();
		}

		const occupiedRooms = await db.query.rooms.findMany({
			where: and(eq(rooms.propertyId, propertyId), isNotNull(rooms.tenantId)),
			with: {
				tenant: { with: { user: { columns: { name: true, phone: true } } } },
				services: { with: { service: true } },
				paymentAccount: true
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

		// Xếp loại từng phòng cho smart bulk: SẴN SÀNG (đủ chỉ số ĐÃ DUYỆT, không bất thường, manual có
		// mặc định) vs CẦN XEM (thiếu/chưa duyệt chỉ số, bất thường, số mới < số cũ, thiếu khoản tự nhập).
		// Chỉ phân loại — KHÔNG đụng logic tính tiền; giúp UI cho phép 1-click duyệt phần sạch.
		const invoicedRoomIds = new Set(
			roomIds.length
				? (
						await db
							.select({ roomId: invoices.roomId })
							.from(invoices)
							.where(and(inArray(invoices.roomId, roomIds), eq(invoices.month, month)))
					).map((r) => r.roomId)
				: []
		);
		const readiness: Record<
			string,
			{ state: 'ready' | 'needs_review' | 'invoiced'; reasons: string[] }
		> = {};
		for (const room of occupiedRooms) {
			if (invoicedRoomIds.has(room.id)) {
				readiness[room.id] = { state: 'invoiced', reasons: ['Đã có hoá đơn tháng này'] };
				continue;
			}
			const roomReadings = (readings[room.id] || {}) as Record<
				string,
				{ status?: string; isAnomalous?: boolean; prevValue?: number; currValue?: number }
			>;
			const reasons: string[] = [];
			for (const config of room.services) {
				if (!config.service.isActive) continue;
				if (config.service.type === 'METERED') {
					const r = roomReadings[config.serviceId];
					if (!r || r.status !== 'approved') {
						reasons.push(`Chưa có/chưa duyệt chỉ số ${config.service.name}`);
					} else if (r.isAnomalous) {
						reasons.push(`Chỉ số ${config.service.name} bất thường`);
					} else if (Number(r.currValue) < Number(r.prevValue)) {
						reasons.push(`Số mới ${config.service.name} nhỏ hơn số cũ`);
					}
				} else if (config.service.type === 'MANUAL_AMOUNT') {
					const hasDefault = (config.customRate ?? config.service.defaultRate ?? 0) > 0;
					if (!hasDefault) reasons.push(`Cần nhập ${config.service.name}`);
				}
			}
			readiness[room.id] = { state: reasons.length ? 'needs_review' : 'ready', reasons };
		}

		return json({
			rooms: occupiedRooms.map(toBulkInvoicePrepRoomDto),
			readings,
			prevValues,
			readiness
		});
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
