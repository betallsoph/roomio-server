import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Băm mật khẩu bằng bcrypt (cost 10). Hỗ trợ nâng cấp mượt từ hash SHA-256 cũ:
// tài khoản cũ vẫn đăng nhập được, lần đăng nhập đúng đầu tiên sẽ tự băm lại sang bcrypt.

const BCRYPT_ROUNDS = 10;
// SHA-256 hex digest dài đúng 64 ký tự hex; bcrypt bắt đầu bằng "$2a$/$2b$" và dài 60 ký tự.
const LEGACY_SHA256 = /^[a-f0-9]{64}$/;

export async function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function sha256(password: string): string {
	return crypto.createHash('sha256').update(password).digest('hex');
}

// Trả về { valid, needsRehash }. needsRehash = true khi mật khẩu đúng nhưng đang lưu hash SHA-256 cũ,
// để nơi gọi băm lại và cập nhật DB sang bcrypt.
export async function verifyPassword(
	password: string,
	storedHash: string
): Promise<{ valid: boolean; needsRehash: boolean }> {
	if (LEGACY_SHA256.test(storedHash)) {
		const valid = sha256(password) === storedHash;
		return { valid, needsRehash: valid };
	}
	const valid = await bcrypt.compare(password, storedHash);
	return { valid, needsRehash: false };
}
