import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { landlordProfiles } from '$lib/server/db/schema';
import { tryDecryptSecret } from '$lib/server/secrets';

const PAYOS_API_BASE = process.env.PAYOS_API_BASE ?? 'https://api-merchant.payos.vn';

export interface PayOSConfig {
	clientId: string;
	apiKey: string;
	checksumKey: string;
}

export interface PayOSPaymentLinkData {
	bin: string;
	accountNumber: string;
	accountName: string;
	amount: number;
	description: string;
	orderCode: number;
	currency: string;
	paymentLinkId: string;
	status: string;
	checkoutUrl: string;
	qrCode: string;
}

// Cấu hình PayOS của NỀN TẢNG (từ env) — dùng cho dòng tiền chủ trọ → SuperAdmin (subscription)
// và cho webhook subscription. KHÔNG dùng cho tiền thuê (tiền thuê dùng key riêng từng chủ trọ).
export function getPlatformPayOSConfig(): PayOSConfig | null {
	const clientId = process.env.PAYOS_CLIENT_ID;
	const apiKey = process.env.PAYOS_API_KEY;
	const checksumKey = process.env.PAYOS_CHECKSUM_KEY;
	if (!clientId || !apiKey || !checksumKey) return null;
	return { clientId, apiKey, checksumKey };
}

// Chọn cấu hình PayOS theo ngữ cảnh dòng tiền:
//  - subscription (chủ trọ trả phí cho nền tảng) → key nền tảng (env)
//  - rent (khách thuê trả tiền thuê cho chủ trọ)  → key RIÊNG của chủ trọ (giải mã từ DB);
//    trả null nếu chủ trọ chưa kết nối PayOS → caller rơi về VietQR + xác nhận thủ công.
export async function resolvePayOSConfig(
	ctx: { scope: 'subscription' } | { scope: 'rent'; landlordId: string }
): Promise<PayOSConfig | null> {
	if (ctx.scope === 'subscription') return getPlatformPayOSConfig();

	const profile = await db.query.landlordProfiles.findFirst({
		where: eq(landlordProfiles.id, ctx.landlordId),
		columns: { payosClientId: true, payosApiKeyEnc: true, payosChecksumKeyEnc: true }
	});
	if (!profile?.payosClientId || !profile.payosApiKeyEnc || !profile.payosChecksumKeyEnc) return null;

	const apiKey = tryDecryptSecret(profile.payosApiKeyEnc);
	const checksumKey = tryDecryptSecret(profile.payosChecksumKeyEnc);
	if (!apiKey || !checksumKey) return null;

	return { clientId: profile.payosClientId, apiKey, checksumKey };
}

export function getPublicOrigin() {
	return process.env.PUBLIC_APP_ORIGIN ?? process.env.ORIGIN ?? 'http://localhost:5173';
}

function normalizeSignatureValue(value: unknown): string {
	if (value === null || value === undefined || value === 'undefined' || value === 'null') return '';
	if (Array.isArray(value)) {
		return JSON.stringify(
			value.map((item) =>
				item && typeof item === 'object' && !Array.isArray(item) ? sortObjectByKey(item as Record<string, unknown>) : item
			)
		);
	}
	return String(value);
}

function sortObjectByKey(object: Record<string, unknown>) {
	return Object.keys(object)
		.sort()
		.reduce<Record<string, unknown>>((acc, key) => {
			acc[key] = object[key];
			return acc;
		}, {});
}

export function createPayOSSignature(data: Record<string, unknown>, checksumKey: string) {
	const sorted = sortObjectByKey(data);
	const query = Object.keys(sorted)
		.filter((key) => sorted[key] !== undefined)
		.map((key) => `${key}=${normalizeSignatureValue(sorted[key])}`)
		.join('&');
	return crypto.createHmac('sha256', checksumKey).update(query).digest('hex');
}

export function verifyPayOSWebhook(data: Record<string, unknown>, signature: string, checksumKey: string) {
	const expected = createPayOSSignature(data, checksumKey);
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// orderCode PayOS: số nguyên dương DUY NHẤT theo merchant. Sinh tất định từ seed để bấm lại
// vẫn ra cùng mã (idempotent). KHI link cũ bị HỦY/HẾT HẠN, caller phải đổi seed vì PayOS
// CẤM tái dùng orderCode đã tồn tại (kể cả link đã hủy).
export function makePayOSOrderCode(seed: string) {
	const hash = crypto.createHash('sha256').update(seed).digest();
	const value = hash.readUInt32BE(0) % 900_000_000;
	return 100_000_000 + value;
}

export async function createPayOSPaymentLink(
	config: PayOSConfig,
	input: {
		invoiceId: string;
		orderCode: number;
		amount: number;
		description: string;
		buyerName: string;
		buyerPhone: string;
		items: { name: string; quantity: number; price: number }[];
	}
) {
	const origin = getPublicOrigin().replace(/\/$/, '');
	const cancelUrl = `${origin}/tenant?payment=cancel&invoice=${encodeURIComponent(input.invoiceId)}`;
	const returnUrl = `${origin}/tenant?payment=success&invoice=${encodeURIComponent(input.invoiceId)}`;
	const amount = Math.round(input.amount);
	const description = input.description.slice(0, 25);
	const signature = createPayOSSignature(
		{ amount, cancelUrl, description, orderCode: input.orderCode, returnUrl },
		config.checksumKey
	);

	const payload = {
		orderCode: input.orderCode,
		amount,
		description,
		buyerName: input.buyerName,
		buyerPhone: input.buyerPhone,
		items: input.items.map((item) => ({
			name: item.name.slice(0, 120),
			quantity: item.quantity,
			price: Math.round(item.price)
		})),
		cancelUrl,
		returnUrl,
		signature
	};

	const response = await fetch(`${PAYOS_API_BASE}/v2/payment-requests`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-client-id': config.clientId,
			'x-api-key': config.apiKey
		},
		body: JSON.stringify(payload)
	});
	const body = await response.json();
	if (!response.ok || body.code !== '00') {
		throw new Error(body.desc || 'Không tạo được link thanh toán PayOS');
	}

	// Fix C: verify chữ ký phản hồi tạo link (chống giả mạo response từ phía PayOS/MITM)
	if (body.signature) {
		const expected = createPayOSSignature((body.data ?? {}) as Record<string, unknown>, config.checksumKey);
		const a = Buffer.from(String(body.signature));
		const b = Buffer.from(expected);
		if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
			throw new Error('Chữ ký phản hồi PayOS không khớp');
		}
	}

	return body.data as PayOSPaymentLinkData;
}

// Đăng ký/confirm webhook URL với PayOS bằng key của 1 merchant. PayOS sẽ ping thử URL,
// nên hàm này vừa validate key vừa đăng ký webhook — dùng cho nút "Kiểm tra kết nối".
export async function confirmPayOSWebhook(config: PayOSConfig, webhookUrl: string) {
	const response = await fetch(`${PAYOS_API_BASE}/confirm-webhook`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-client-id': config.clientId,
			'x-api-key': config.apiKey
		},
		body: JSON.stringify({ webhookUrl })
	});
	const body = (await response.json().catch(() => ({}))) as { code?: string; desc?: string };
	if (!response.ok || (body.code !== undefined && body.code !== '00')) {
		throw new Error(body.desc || 'PayOS không xác nhận được webhook URL (kiểm tra lại key hoặc URL công khai)');
	}
	return true;
}
