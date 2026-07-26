import { Receiver } from '@upstash/qstash';

function signingKeys() {
	const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
	const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
	if (!currentSigningKey || !nextSigningKey) {
		return null;
	}
	return { currentSigningKey, nextSigningKey };
}

export function isQStashConfigured() {
	return signingKeys() !== null;
}

/** Xác thực request từ Upstash QStash (header Upstash-Signature). */
export async function verifyQStashRequest(request: Request, body: string) {
	const keys = signingKeys();
	if (!keys) {
		throw new Error('QSTASH_CURRENT_SIGNING_KEY và QSTASH_NEXT_SIGNING_KEY chưa cấu hình');
	}

	const signature = request.headers.get('upstash-signature');
	if (!signature) {
		return { ok: false as const, status: 403, error: 'Thiếu header Upstash-Signature' };
	}

	const receiver = new Receiver(keys);
	const isValid = await receiver.verify({
		signature,
		body,
		upstashRegion: request.headers.get('upstash-region') ?? undefined
	});

	if (!isValid) {
		return { ok: false as const, status: 403, error: 'Chữ ký QStash không hợp lệ' };
	}

	return { ok: true as const };
}
