import fs from 'fs/promises';
import path from 'path';
import { db } from '../src/lib/server/db';
import { meterReadings, invoices } from '../src/lib/server/db/schema';
import { and, isNotNull, lt, like } from 'drizzle-orm';

// Dọn ảnh đối chiếu quá 3 tháng (ảnh đồng hồ, bill chuyển khoản) theo đúng
// chính sách lưu trữ: số liệu giữ vĩnh viễn, chỉ xóa file ảnh.
// Chạy định kỳ bằng cron: npm run cleanup:uploads

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? 'uploads';
const RETENTION_MONTHS = 3;

function monthsAgo(n: number): string {
	const d = new Date();
	d.setMonth(d.getMonth() - n);
	return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
}

async function deleteUploadedFile(url: string) {
	const name = url.split('/').pop();
	if (!name) return;
	try {
		await fs.unlink(path.join(UPLOAD_DIR, name));
		console.log(`Đã xóa file ${name}`);
	} catch {
		// File đã bị xóa trước đó hoặc là URL ngoài — bỏ qua
	}
}

async function main() {
	const cutoffMonth = monthsAgo(RETENTION_MONTHS);
	console.log(`Dọn ảnh của các tháng trước ${cutoffMonth}...`);

	// 1. Ảnh chụp đồng hồ
	const oldReadings = await db
		.select({ id: meterReadings.id, photoUrl: meterReadings.photoUrl })
		.from(meterReadings)
		.where(
			and(
				lt(meterReadings.month, cutoffMonth),
				isNotNull(meterReadings.photoUrl),
				like(meterReadings.photoUrl, '/api/files/%')
			)
		);

	for (const reading of oldReadings) {
		await deleteUploadedFile(reading.photoUrl!);
	}
	if (oldReadings.length > 0) {
		await db
			.update(meterReadings)
			.set({ photoUrl: null })
			.where(
				and(lt(meterReadings.month, cutoffMonth), like(meterReadings.photoUrl, '/api/files/%'))
			);
	}

	// 2. Ảnh bill chuyển khoản của hóa đơn cũ
	const oldInvoices = await db
		.select({ id: invoices.id, paymentProofImage: invoices.paymentProofImage })
		.from(invoices)
		.where(
			and(
				lt(invoices.month, cutoffMonth),
				isNotNull(invoices.paymentProofImage),
				like(invoices.paymentProofImage, '/api/files/%')
			)
		);

	for (const invoice of oldInvoices) {
		await deleteUploadedFile(invoice.paymentProofImage!);
	}
	if (oldInvoices.length > 0) {
		await db
			.update(invoices)
			.set({ paymentProofImage: null })
			.where(
				and(lt(invoices.month, cutoffMonth), like(invoices.paymentProofImage, '/api/files/%'))
			);
	}

	console.log(
		`Hoàn tất: đã dọn ${oldReadings.length} ảnh đồng hồ, ${oldInvoices.length} ảnh bill.`
	);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
