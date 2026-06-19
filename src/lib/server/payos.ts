import crypto from 'crypto';

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

export function getPayOSConfig(): PayOSConfig | null {
	const clientId = process.env.PAYOS_CLIENT_ID;
	const apiKey = process.env.PAYOS_API_KEY;
	const checksumKey = process.env.PAYOS_CHECKSUM_KEY;
	if (!clientId || !apiKey || !checksumKey) return null;
	return { clientId, apiKey, checksumKey };
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

export function makePayOSOrderCode(invoiceId: string, existingOrderCode?: string | null) {
	if (existingOrderCode) return Number(existingOrderCode);
	const hash = crypto.createHash('sha256').update(invoiceId).digest();
	const value = hash.readUInt32BE(0) % 900_000_000;
	return 100_000_000 + value;
}

export async function createPayOSPaymentLink(input: {
	invoiceId: string;
	orderCode: number;
	amount: number;
	description: string;
	buyerName: string;
	buyerPhone: string;
	items: { name: string; quantity: number; price: number }[];
}) {
	const config = getPayOSConfig();
	if (!config) {
		throw new Error('Chưa cấu hình PAYOS_CLIENT_ID, PAYOS_API_KEY và PAYOS_CHECKSUM_KEY');
	}

	const origin = getPublicOrigin().replace(/\/$/, '');
	const cancelUrl = `${origin}/tenant?payment=cancel&invoice=${encodeURIComponent(input.invoiceId)}`;
	const returnUrl = `${origin}/tenant?payment=success&invoice=${encodeURIComponent(input.invoiceId)}`;
	const amount = Math.round(input.amount);
	const description = input.description.slice(0, 25);
	const signature = createPayOSSignature(
		{
			amount,
			cancelUrl,
			description,
			orderCode: input.orderCode,
			returnUrl
		},
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
	return body.data as PayOSPaymentLinkData;
}
