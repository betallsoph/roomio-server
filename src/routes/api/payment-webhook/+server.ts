import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, rooms } from '$lib/server/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';

// Nhận webhook từ SePay/Casso khi có tiền vào tài khoản ngân hàng của chủ trọ.
// Nội dung chuyển khoản chứa mã hóa đơn (đã nhúng sẵn trong mã VietQR) nên có thể
// tự động đối soát và xác nhận thanh toán — không cần khách gửi bill chụp màn hình.
//
// Cấu hình: đặt biến môi trường SEPAY_API_KEY và khai báo webhook trên SePay với
// header "Authorization: Apikey <SEPAY_API_KEY>".

// Mã hóa đơn dạng INV-202606-1234; ngân hàng có thể bỏ dấu gạch trong nội dung CK
const INVOICE_CODE_PATTERN = /INV[-\s]?(\d{6})[-\s]?(\d{4})/i;

export const POST: RequestHandler = async ({ request }) => {
	try {
		const apiKey = process.env.SEPAY_API_KEY;
		if (apiKey) {
			const auth = request.headers.get('authorization');
			if (auth !== `Apikey ${apiKey}`) {
				return json({ error: 'Sai API key' }, { status: 401 });
			}
		}

		const body = await request.json();
		// Định dạng webhook SePay: https://developer.sepay.vn
		const { content, transferAmount, transferType } = body;

		if (transferType !== 'in' || !content || !transferAmount) {
			return json({ success: true, message: 'Bỏ qua giao dịch không liên quan' });
		}

		const match = String(content).match(INVOICE_CODE_PATTERN);
		if (!match) {
			return json({ success: true, message: 'Không tìm thấy mã hóa đơn trong nội dung CK' });
		}

		// Hóa đơn có thể mang một trong hai định dạng mã: INV-YYYYMM-XXXX hoặc INV-YYYYMMXXXX
		const candidates = [`INV-${match[1]}-${match[2]}`, `INV-${match[1]}${match[2]}`];
		const invoice = await db.query.invoices.findFirst({
			where: inArray(invoices.id, candidates)
		});

		if (!invoice) {
			return json({ success: true, message: `Không tìm thấy hóa đơn ${candidates[0]}` });
		}

		const invoiceId = invoice.id;

		if (invoice.status === 'paid') {
			return json({ success: true, message: 'Hóa đơn đã được thanh toán trước đó' });
		}

		const amount = Number(transferAmount);
		const newPaidAmount = invoice.paidAmount + amount;
		const fullyPaid = newPaidAmount >= invoice.totalAmount;
		const today = new Date().toISOString().split('T')[0];

		await db.transaction(async (tx) => {
			await tx
				.update(invoices)
				.set({
					paidAmount: newPaidAmount,
					status: fullyPaid ? 'paid' : 'partial',
					paidDate: fullyPaid ? today : null,
					paymentMethod: 'bank_webhook'
				})
				.where(eq(invoices.id, invoiceId));

			await tx
				.update(rooms)
				.set({
					debtAmount: sql`greatest(coalesce(${rooms.debtAmount}, 0) - ${amount}, 0)`,
					...(fullyPaid ? { status: 'paid' } : {})
				})
				.where(eq(rooms.id, invoice.roomId));
		});

		return json({ success: true, invoiceId, status: fullyPaid ? 'paid' : 'partial' });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
