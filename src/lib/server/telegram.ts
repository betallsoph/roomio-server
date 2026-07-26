import crypto from 'crypto';
import { getEnv, isTelegramConfigured } from './env';
// Tài liệu: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// initData là một query-string đã được Telegram ký. Backend verify chữ ký bằng BOT_TOKEN để
// tin được "đây đúng là user Telegram X" mà không cần mật khẩu.

// initData cũ hơn khoảng thời gian này (giây) bị coi là hết hạn — chống replay nếu chuỗi bị lộ.
const INIT_DATA_MAX_AGE_SECONDS = 60 * 60; // 1 giờ

function botToken(): string {
	const telegram = getEnv().telegram;
	return telegram.status === 'CONFIGURED' ? telegram.botToken : '';
}

export interface TelegramUser {
	id: number;
	first_name?: string;
	last_name?: string;
	username?: string;
	language_code?: string;
	is_premium?: boolean;
	photo_url?: string;
}

export interface VerifiedInitData {
	user: TelegramUser;
	authDate: number;
	startParam: string | null;
	queryId: string | null;
}

export class TelegramAuthError extends Error {}

export function telegramConfigured(): boolean {
	return isTelegramConfigured();
}

export function verifyInitData(initData: string): VerifiedInitData {
	const token = botToken();
	if (!token) {
		throw new TelegramAuthError('Server chưa cấu hình BOT_TOKEN');
	}
	if (!initData) {
		throw new TelegramAuthError('Thiếu initData');
	}

	const params = new URLSearchParams(initData);
	const hash = params.get('hash');
	if (!hash) {
		throw new TelegramAuthError('initData thiếu hash');
	}

	// data_check_string: tất cả các cặp TRỪ `hash`, sort theo key, nối bằng '\n'.
	// Telegram mới có thêm `signature`; trường này vẫn thuộc chuỗi HMAC khi verify bằng bot token.
	// URLSearchParams trả về value đã URL-decode — dùng đúng chuỗi này, KHÔNG parse rồi stringify
	// lại `user` (sẽ làm đổi hash → verify fail). Đây là lỗi kinh điển khi tự code.
	const pairs: string[] = [];
	for (const [key, value] of params.entries()) {
		if (key === 'hash') continue;
		pairs.push(`${key}=${value}`);
	}
	pairs.sort();
	const dataCheckString = pairs.join('\n');

	// secret_key = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
	const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
	// computed = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
	const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

	const a = Buffer.from(computed);
	const b = Buffer.from(hash);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
		throw new TelegramAuthError('Chữ ký initData không hợp lệ');
	}

	const authDate = Number(params.get('auth_date'));
	if (!authDate || Number.isNaN(authDate)) {
		throw new TelegramAuthError('initData thiếu auth_date');
	}
	const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
	if (ageSeconds > INIT_DATA_MAX_AGE_SECONDS || ageSeconds < -INIT_DATA_MAX_AGE_SECONDS) {
		throw new TelegramAuthError('initData đã hết hạn, vui lòng mở lại app');
	}

	const userRaw = params.get('user');
	if (!userRaw) {
		throw new TelegramAuthError('initData thiếu thông tin user');
	}
	let user: TelegramUser;
	try {
		user = JSON.parse(userRaw);
	} catch {
		throw new TelegramAuthError('initData user không hợp lệ');
	}
	if (typeof user.id !== 'number') {
		throw new TelegramAuthError('initData user.id không hợp lệ');
	}

	return {
		user,
		authDate,
		startParam: params.get('start_param'),
		queryId: params.get('query_id')
	};
}
