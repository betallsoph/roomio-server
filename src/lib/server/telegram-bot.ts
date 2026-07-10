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
		file_path?: string;
	};
	parameters?: {
		retry_after?: number;
	};
}

interface TelegramMessageOptions {
	replyMarkup?: unknown;
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

export function buildTenantAnnouncementText(title: string, content: string) {
	const miniAppUrl = buildMiniAppUrl();
	const parts = ['Thông báo từ chủ trọ', '', title.trim(), '', content.trim()];
	if (miniAppUrl) {
		parts.push('', `Mở Roomio để xem chi tiết: ${miniAppUrl}`);
	}
	return trimTelegramText(parts.join('\n'));
}

export async function sendTelegramMessage(
	chatId: string,
	text: string,
	options: TelegramMessageOptions = {}
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
				text: trimTelegramText(text),
				...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
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

export async function answerTelegramCallbackQuery(callbackQueryId: string) {
	if (!BOT_TOKEN || !callbackQueryId.trim()) return;

	await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ callback_query_id: callbackQueryId })
	}).catch(() => null);
}

export async function getTelegramFilePath(fileId: string) {
	if (!BOT_TOKEN) throw new Error('Server chưa cấu hình BOT_TOKEN');
	if (!fileId.trim()) throw new Error('Thiếu Telegram file ID');

	const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ file_id: fileId })
	});
	const payload = (await res.json().catch(() => null)) as TelegramApiResponse | null;
	if (!res.ok || !payload?.ok || !payload.result?.file_path) {
		throw new Error(payload?.description || `Telegram trả về HTTP ${res.status}`);
	}
	return payload.result.file_path;
}

export async function downloadTelegramFile(filePath: string) {
	if (!BOT_TOKEN) throw new Error('Server chưa cấu hình BOT_TOKEN');
	if (!filePath.trim()) throw new Error('Thiếu Telegram file path');

	const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
	if (!res.ok) throw new Error(`Không tải được ảnh Telegram: HTTP ${res.status}`);

	const contentType = res.headers.get('content-type')?.split(';')[0]?.toLowerCase() || 'image/jpeg';
	const body = new Uint8Array(await res.arrayBuffer());
	return { body, contentType };
}
