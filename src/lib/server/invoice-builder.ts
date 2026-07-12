// Tính các dòng của một hóa đơn cho 1 phòng — dùng chung cho lập tay (bulk) và tự soạn nháp (cron).
// Thuần logic, không đụng DB, để hai đường không lệch cách tính.

export interface RoomForBilling {
	id: string;
	roomNumber: string;
	monthlyRent: number;
	services: Array<{
		serviceId: string;
		customRate: number | null;
		quantity: number;
		service: { name: string; type: string; defaultRate: number; isActive: boolean };
	}>;
}

export interface RoomBillingInput {
	readings?: Record<string, { prevValue: number; currValue: number }>; // theo serviceId
	manualAmounts?: Record<string, number>;
	adjustments?: Array<{ name: string; amount: number }>;
	prorate?: number | null; // 0..1 — tỉ lệ tiền phòng cho khách vào/ra giữa tháng
}

export interface BuiltInvoice {
	items: Array<{ name: string; amount: number; details: string }>;
	rentAmount: number;
	totalAmount: number;
	// Chỉ số điện/nước cần ghi nhận kèm (chỉ có ở dịch vụ METERED)
	meterReadings: Array<{ serviceId: string; prevValue: number; currValue: number }>;
}

const fmt = (n: number) => new Intl.NumberFormat('vi-VN').format(n);

export function buildInvoiceItems(
	room: RoomForBilling,
	month: string,
	input: RoomBillingInput
): BuiltInvoice {
	const readings = input.readings ?? {};
	const manualAmounts = input.manualAmounts ?? {};

	// Tiền phòng — hỗ trợ prorate cho khách vào/ra giữa tháng
	const rentFactorRaw = Number(input.prorate);
	const rentFactor =
		Number.isFinite(rentFactorRaw) && rentFactorRaw > 0 && rentFactorRaw < 1 ? rentFactorRaw : 1;
	const rentAmount = Math.round(room.monthlyRent * rentFactor);

	const items: BuiltInvoice['items'] = [
		{
			name: 'Tiền phòng',
			amount: rentAmount,
			details:
				rentFactor < 1
					? `Tiền thuê tháng ${month.split('-')[1]}/${month.split('-')[0]} (tính ${Math.round(rentFactor * 100)}%)`
					: `Tiền thuê phòng tháng ${month.split('-')[1]}/${month.split('-')[0]}`
		}
	];

	const meterReadings: BuiltInvoice['meterReadings'] = [];
	let totalServicesAmount = 0;

	for (const config of room.services) {
		if (!config.service.isActive) continue;

		const rate = config.customRate !== null ? config.customRate : config.service.defaultRate;
		let amount = 0;
		let details = '';
		const type = config.service.type;

		if (type === 'METERED') {
			const serviceReading = readings[config.serviceId] || { prevValue: 0, currValue: 0 };
			const prev = Number(serviceReading.prevValue) || 0;
			const curr = Number(serviceReading.currValue) || 0;
			const usage = curr - prev;
			amount = usage * rate;
			details = `Chỉ số: ${prev} -> ${curr} (${usage} ${config.service.name === 'Điện' ? 'kWh' : 'm³'}) x ${fmt(rate)}đ`;
			meterReadings.push({ serviceId: config.serviceId, prevValue: prev, currValue: curr });
		} else if (type === 'FLAT_ROOM') {
			amount = rate * config.quantity;
			details = `Phí cố định x ${config.quantity} phòng`;
		} else if (type === 'FLAT_PERSON') {
			amount = rate * config.quantity;
			details = `Đơn giá: ${fmt(rate)}đ x ${config.quantity} người`;
		} else if (type === 'FLAT_VEHICLE') {
			amount = rate * config.quantity;
			details = `Đơn giá: ${fmt(rate)}đ x ${config.quantity} xe`;
		} else if (type === 'MANUAL_AMOUNT') {
			if (manualAmounts[config.serviceId] === undefined) {
				throw new Error(`Thiếu số tiền ${config.service.name} cho phòng ${room.roomNumber}`);
			}
			amount = Number(manualAmounts[config.serviceId]);
			if (!Number.isFinite(amount) || amount < 0) {
				throw new Error(`Số tiền ${config.service.name} của phòng ${room.roomNumber} không hợp lệ`);
			}
			details = `Khoản tự nhập tháng ${month}`;
		}

		if (amount > 0) {
			items.push({ name: config.service.name, amount, details });
			totalServicesAmount += amount;
		}
	}

	// Phụ thu / giảm 1 lần (amount âm = giảm)
	let adjustmentsTotal = 0;
	for (const adj of input.adjustments ?? []) {
		const name = typeof adj?.name === 'string' ? adj.name.trim() : '';
		const amt = Number(adj?.amount);
		if (!name || !Number.isFinite(amt) || amt === 0) continue;
		items.push({ name, amount: amt, details: 'Điều chỉnh 1 lần' });
		adjustmentsTotal += amt;
	}

	const totalAmount = rentAmount + totalServicesAmount + adjustmentsTotal;
	return { items, rentAmount, totalAmount, meterReadings };
}

// Quy tắc chung: phòng "sẵn sàng" để tự soạn nháp = mọi dịch vụ METERED đang bật đều có chỉ số
// ĐÃ DUYỆT, không bất thường, số mới >= số cũ; dịch vụ MANUAL_AMOUNT có mức mặc định > 0.
export function roomReadyForAutoDraft(
	room: RoomForBilling,
	approvedReadingByService: Record<string, { prevValue: number; currValue: number } | undefined>,
	anomalousServiceIds: Set<string>
): boolean {
	for (const config of room.services) {
		if (!config.service.isActive) continue;
		if (config.service.type === 'METERED') {
			const r = approvedReadingByService[config.serviceId];
			if (!r) return false;
			if (anomalousServiceIds.has(config.serviceId)) return false;
			if (Number(r.currValue) < Number(r.prevValue)) return false;
		} else if (config.service.type === 'MANUAL_AMOUNT') {
			const def = config.customRate ?? config.service.defaultRate ?? 0;
			if (!(def > 0)) return false;
		}
	}
	return true;
}
