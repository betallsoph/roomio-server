const BOT_TOKEN = process.env.BOT_TOKEN?.trim() ?? '';
const BOT_USERNAME = process.env.BOT_USERNAME?.trim() ?? '';
const MINIAPP_SHORT_NAME = process.env.MINIAPP_SHORT_NAME?.trim() ?? '';

const TELEGRAM_SEND_TIMEOUT_MS = 8_000;
const TELEGRAM_MESSAGE_LIMIT = 4096;

export type TelegramSendResult =
	| { ok: true; telegramMessageId: number | null }
	| {
			ok: false;
			code: 'not_configured' | 'bad_request' | 'forbidden' | 'rate_limited' | 'timeout' | 'network';
			message: string;
			retryable: boolean;
			status?: number;
			retryAfterSeconds?: number;
	  };

interface TelegramApiResponse {
	ok: boolean;
	description?: string;
	result?: {
		message_id?: number;
	};
	parameters?: {
		retry_after?: number;
	};
}

function trimTelegramText(text: string) {
	if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
	return `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 24).trimEnd()}\n...(tin nhắn đã rút gọn)`;
}

export function buildMiniAppUrl() {
	if (!BOT_USERNAME || !MINIAPP_SHORT_NAME) return null;
	return `https://t.me/${BOT_USERNAME}/${MINIAPP_SHORT_NAME}`;
}

export function buildTenantDirectMessageText(content: string) {
	const miniAppUrl = buildMiniAppUrl();
	const parts = ['Bạn có tin nhắn mới từ chủ trọ', '', content.trim()];
	if (miniAppUrl) {
		parts.push('', `Mở Roomio để trả lời: ${miniAppUrl}`);
	}
	return trimTelegramText(parts.join('\n'));
}

export async function sendTelegramMessage(
	chatId: string,
	text: string
): Promise<TelegramSendResult> {
	if (!BOT_TOKEN) {
		return {
			ok: false,
			code: 'not_configured',
			message: 'Server chưa cấu hình BOT_TOKEN',
			retryable: false
		};
	}
	if (!chatId.trim()) {
		return {
			ok: false,
			code: 'bad_request',
			message: 'Thiếu Telegram chat ID',
			retryable: false
		};
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TELEGRAM_SEND_TIMEOUT_MS);

	try {
		const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: trimTelegramText(text)
			}),
			signal: controller.signal
		});

		const payload = (await res.json().catch(() => null)) as TelegramApiResponse | null;
		if (res.ok && payload?.ok) {
			return { ok: true, telegramMessageId: payload.result?.message_id ?? null };
		}

		const description = payload?.description || `Telegram trả về HTTP ${res.status}`;
		if (res.status === 403) {
			return {
				ok: false,
				code: 'forbidden',
				message: description,
				retryable: false,
				status: res.status
			};
		}
		if (res.status === 429) {
			return {
				ok: false,
				code: 'rate_limited',
				message: description,
				retryable: true,
				status: res.status,
				retryAfterSeconds: payload?.parameters?.retry_after
			};
		}
		if (res.status >= 500) {
			return {
				ok: false,
				code: 'network',
				message: description,
				retryable: true,
				status: res.status
			};
		}
		return {
			ok: false,
			code: 'bad_request',
			message: description,
			retryable: false,
			status: res.status
		};
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return {
				ok: false,
				code: 'timeout',
				message: 'Gửi Telegram quá thời gian chờ',
				retryable: true
			};
		}
		return {
			ok: false,
			code: 'network',
			message: error instanceof Error ? error.message : 'Không gọi được Telegram Bot API',
			retryable: true
		};
	} finally {
		clearTimeout(timeout);
	}
}
