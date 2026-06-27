import crypto from 'crypto';

// Mã hóa secret nhạy cảm (PayOS apiKey/checksumKey của từng chủ trọ) trước khi lưu DB.
// Thuật toán: AES-256-GCM. Khóa lấy từ env PAYOS_ENC_KEY (khuyến nghị: openssl rand -base64 32).
// Định dạng lưu: base64(iv).base64(authTag).base64(ciphertext)

const RAW_KEY = process.env.PAYOS_ENC_KEY ?? '';

function getKey(): Buffer {
	if (!RAW_KEY) {
		throw new Error('Chưa cấu hình PAYOS_ENC_KEY để mã hóa khóa PayOS');
	}
	// Chấp nhận key dạng base64 32 byte; nếu không đúng 32 byte thì băm SHA-256 về đúng 32 byte.
	const buf = Buffer.from(RAW_KEY, 'base64');
	return buf.length === 32 ? buf : crypto.createHash('sha256').update(RAW_KEY).digest();
}

export function encryptSecret(plain: string): string {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
	const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
	const [ivB64, tagB64, dataB64] = payload.split('.');
	if (!ivB64 || !tagB64 || !dataB64) {
		throw new Error('Dữ liệu mã hóa PayOS không hợp lệ');
	}
	const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
	const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
	return dec.toString('utf8');
}

// Giải mã an toàn: trả null thay vì throw nếu bản ghi hỏng/khóa sai — tránh làm vỡ cả luồng.
export function tryDecryptSecret(payload: string | null | undefined): string | null {
	if (!payload) return null;
	try {
		return decryptSecret(payload);
	} catch {
		return null;
	}
}
