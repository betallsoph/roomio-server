import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	maintenanceRequests,
	properties,
	rooms,
	telegramBotSessions,
	tenantProfiles,
	users
} from '$lib/server/db/schema';
import {
	answerTelegramCallbackQuery,
	downloadTelegramFile,
	getTelegramFilePath,
	sendTelegramMessage
} from '$lib/server/telegram-bot';
import { uploadR2Object } from '$lib/server/r2';
import { and, eq, lt } from 'drizzle-orm';

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
const FLOW = 'maintenance_request';
const SESSION_TTL_MS = 30 * 60 * 1000;

type IssueCategory = 'maintenance' | 'plumbing' | 'electrical' | 'internet' | 'other';

interface TelegramUser {
	id: number;
}

interface TelegramPhoto {
	file_id: string;
	file_size?: number;
	width: number;
	height: number;
}

interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: {
		id: number | string;
		type?: string;
	};
	text?: string;
	caption?: string;
	photo?: TelegramPhoto[];
}

interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: {
		chat: {
			id: number | string;
		};
	};
	data?: string;
}

interface TelegramUpdate {
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface IssueDraft {
	category?: IssueCategory;
	description?: string;
}

interface TenantRoomContext {
	tenantId: string;
	userId: string;
	tenantName: string;
	roomNumber: string;
	buildingName: string;
	landlordId: string;
}

const CATEGORY_LABELS: Record<IssueCategory, string> = {
	maintenance: 'Nội thất/Gia dụng',
	plumbing: 'Đường nước',
	electrical: 'Hệ thống điện',
	internet: 'Mạng Wifi/Internet',
	other: 'Khác'
};

function sessionExpiry() {
	return new Date(Date.now() + SESSION_TTL_MS);
}

function normalizeCommand(text: string) {
	return text.trim().split(/\s+/)[0]?.split('@')[0]?.toLowerCase() ?? '';
}

function parseDraft(payload: string | null): IssueDraft {
	if (!payload) return {};
	try {
		const parsed = JSON.parse(payload);
		return typeof parsed === 'object' && parsed ? parsed : {};
	} catch {
		return {};
	}
}

function categoryKeyboard() {
	return {
		inline_keyboard: [
			[
				{ text: 'Nội thất', callback_data: 'issue_category:maintenance' },
				{ text: 'Đường nước', callback_data: 'issue_category:plumbing' }
			],
			[
				{ text: 'Điện', callback_data: 'issue_category:electrical' },
				{ text: 'Wifi', callback_data: 'issue_category:internet' }
			],
			[
				{ text: 'Khác', callback_data: 'issue_category:other' },
				{ text: 'Hủy', callback_data: 'issue_cancel' }
			]
		]
	};
}

function photoKeyboard() {
	return {
		inline_keyboard: [
			[
				{ text: 'Bỏ qua ảnh', callback_data: 'issue_skip_photo' },
				{ text: 'Hủy', callback_data: 'issue_cancel' }
			]
		]
	};
}

async function cleanupExpiredSessions() {
	await db.delete(telegramBotSessions).where(lt(telegramBotSessions.expiresAt, new Date()));
}

async function findTenantRoomContext(telegramUserId: string): Promise<TenantRoomContext | null> {
	const rows = await db
		.select({
			tenantId: tenantProfiles.id,
			userId: tenantProfiles.userId,
			tenantName: users.name,
			roomNumber: rooms.roomNumber,
			buildingName: properties.shortName,
			landlordId: properties.landlordId
		})
		.from(tenantProfiles)
		.innerJoin(users, eq(users.id, tenantProfiles.userId))
		.innerJoin(rooms, eq(rooms.tenantId, tenantProfiles.id))
		.innerJoin(properties, eq(properties.id, rooms.propertyId))
		.where(eq(tenantProfiles.telegramUserId, telegramUserId))
		.limit(1);

	return rows[0] ?? null;
}

async function getSession(telegramUserId: string) {
	const session = await db.query.telegramBotSessions.findFirst({
		where: and(
			eq(telegramBotSessions.telegramUserId, telegramUserId),
			eq(telegramBotSessions.flow, FLOW)
		)
	});

	if (!session || session.expiresAt <= new Date()) {
		if (session) {
			await db
				.delete(telegramBotSessions)
				.where(eq(telegramBotSessions.telegramUserId, telegramUserId));
		}
		return null;
	}
	return session;
}

async function saveSession(
	telegramUserId: string,
	tenantId: string,
	step: string,
	draft: IssueDraft
) {
	await db
		.insert(telegramBotSessions)
		.values({
			telegramUserId,
			tenantId,
			flow: FLOW,
			step,
			payload: JSON.stringify(draft),
			expiresAt: sessionExpiry()
		})
		.onConflictDoUpdate({
			target: telegramBotSessions.telegramUserId,
			set: {
				tenantId,
				flow: FLOW,
				step,
				payload: JSON.stringify(draft),
				expiresAt: sessionExpiry(),
				updatedAt: new Date()
			}
		});
}

async function clearSession(telegramUserId: string) {
	await db
		.delete(telegramBotSessions)
		.where(eq(telegramBotSessions.telegramUserId, telegramUserId));
}

async function startIssueFlow(chatId: string, telegramUserId: string) {
	const context = await findTenantRoomContext(telegramUserId);
	if (!context) {
		await sendTelegramMessage(
			chatId,
			'Tài khoản Telegram này chưa liên kết với phòng nào trên Roomio. Bạn mở mini app từ link mời của chủ trọ để liên kết trước nha.'
		);
		return;
	}

	await saveSession(telegramUserId, context.tenantId, 'category', {});
	await sendTelegramMessage(
		chatId,
		`Bạn muốn báo sự cố cho phòng ${context.roomNumber} ở ${context.buildingName}. Chọn loại sự cố nha:`,
		{ replyMarkup: categoryKeyboard() }
	);
}

async function createIssue(
	chatId: string,
	telegramUserId: string,
	draft: IssueDraft,
	imageUrl?: string
) {
	const context = await findTenantRoomContext(telegramUserId);
	if (!context) {
		await clearSession(telegramUserId);
		await sendTelegramMessage(chatId, 'Mình không tìm thấy phòng đang liên kết với Telegram này.');
		return;
	}

	const category = draft.category ?? 'other';
	const label = CATEGORY_LABELS[category];
	const [created] = await db
		.insert(maintenanceRequests)
		.values({
			tenantId: context.tenantId,
			roomNumber: context.roomNumber,
			buildingName: context.buildingName,
			category,
			title: `Báo sự cố: ${label}`,
			description: draft.description?.trim() || 'Khách thuê báo sự cố qua Telegram bot',
			imageUrl,
			priority: 'normal',
			status: 'pending'
		})
		.returning({ id: maintenanceRequests.id });

	await clearSession(telegramUserId);
	await sendTelegramMessage(
		chatId,
		`Đã gửi sự cố cho chủ trọ rồi nha.\nMã sự cố: ${created.id.slice(0, 8)}\nPhòng: ${context.roomNumber} - ${context.buildingName}`
	);
}

async function handlePhoto(chatId: string, telegramUserId: string, photos: TelegramPhoto[]) {
	const session = await getSession(telegramUserId);
	if (!session || session.step !== 'photo') {
		await sendTelegramMessage(chatId, 'Nếu muốn báo sự cố kèm ảnh, bạn gõ /suco trước nha.');
		return;
	}

	const draft = parseDraft(session.payload);
	const photo = [...photos].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
	if (!photo) {
		await sendTelegramMessage(
			chatId,
			'Mình chưa nhận được ảnh. Bạn gửi lại ảnh hoặc bấm bỏ qua ảnh nha.',
			{
				replyMarkup: photoKeyboard()
			}
		);
		return;
	}

	try {
		const filePath = await getTelegramFilePath(photo.file_id);
		const file = await downloadTelegramFile(filePath);
		const uploaded = await uploadR2Object({
			purpose: 'maintenance-request',
			contentType: file.contentType,
			byteSize: file.body.byteLength,
			actorId: session.tenantId ?? telegramUserId,
			actorRole: 'TENANT',
			body: file.body
		});
		await createIssue(chatId, telegramUserId, draft, uploaded.url);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Không lưu được ảnh';
		await sendTelegramMessage(
			chatId,
			`Mình nhận được ảnh nhưng lưu chưa thành công: ${message}\nBạn gửi lại ảnh khác hoặc bấm bỏ qua ảnh nha.`,
			{ replyMarkup: photoKeyboard() }
		);
	}
}

async function handleMessage(message: TelegramMessage) {
	const telegramUserId = message.from?.id ? String(message.from.id) : '';
	const chatId = String(message.chat.id);
	if (!telegramUserId) return;

	if (message.photo?.length) {
		await handlePhoto(chatId, telegramUserId, message.photo);
		return;
	}

	const text = message.text?.trim() ?? '';
	if (!text) return;

	const command = normalizeCommand(text);
	if (['/cancel', '/huy'].includes(command)) {
		await clearSession(telegramUserId);
		await sendTelegramMessage(chatId, 'Đã hủy thao tác hiện tại.');
		return;
	}

	if (['/suco', '/support', '/issue'].includes(command)) {
		await startIssueFlow(chatId, telegramUserId);
		return;
	}

	const session = await getSession(telegramUserId);
	if (!session) {
		await sendTelegramMessage(chatId, 'Bạn gõ /suco để báo sự cố phòng trọ nha.');
		return;
	}

	if (session.step === 'description') {
		if (text.length < 4) {
			await sendTelegramMessage(chatId, 'Bạn mô tả thêm một chút để chủ trọ dễ xử lý nha.');
			return;
		}

		const draft = { ...parseDraft(session.payload), description: text };
		await saveSession(telegramUserId, session.tenantId ?? '', 'photo', draft);
		await sendTelegramMessage(
			chatId,
			'Có ảnh hiện trạng thì gửi ngay trong chat này. Không có thì bấm bỏ qua ảnh.',
			{
				replyMarkup: photoKeyboard()
			}
		);
		return;
	}

	await sendTelegramMessage(chatId, 'Bạn chọn loại sự cố bằng các nút bên dưới nha.', {
		replyMarkup: categoryKeyboard()
	});
}

async function handleCallback(callback: TelegramCallbackQuery) {
	await answerTelegramCallbackQuery(callback.id);

	const telegramUserId = String(callback.from.id);
	const chatId = String(callback.message?.chat.id ?? callback.from.id);
	const data = callback.data ?? '';

	if (data === 'issue_cancel') {
		await clearSession(telegramUserId);
		await sendTelegramMessage(chatId, 'Đã hủy báo sự cố.');
		return;
	}

	if (data === 'issue_skip_photo') {
		const session = await getSession(telegramUserId);
		if (!session || session.step !== 'photo') {
			await sendTelegramMessage(chatId, 'Bạn gõ /suco để báo sự cố mới nha.');
			return;
		}
		await createIssue(chatId, telegramUserId, parseDraft(session.payload));
		return;
	}

	if (data.startsWith('issue_category:')) {
		const category = data.slice('issue_category:'.length) as IssueCategory;
		if (!CATEGORY_LABELS[category]) {
			await sendTelegramMessage(chatId, 'Loại sự cố không hợp lệ. Bạn gõ /suco để thử lại nha.');
			return;
		}

		const context = await findTenantRoomContext(telegramUserId);
		if (!context) {
			await clearSession(telegramUserId);
			await sendTelegramMessage(
				chatId,
				'Mình không tìm thấy phòng đang liên kết với Telegram này.'
			);
			return;
		}

		await saveSession(telegramUserId, context.tenantId, 'description', { category });
		await sendTelegramMessage(
			chatId,
			`Bạn mô tả ngắn sự cố ${CATEGORY_LABELS[category].toLowerCase()} đang gặp nha.`
		);
	}
}

export const POST: RequestHandler = async ({ request }) => {
	if (!WEBHOOK_SECRET) {
		return json({ error: 'Server chưa cấu hình TELEGRAM_WEBHOOK_SECRET' }, { status: 503 });
	}
	if (request.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		await cleanupExpiredSessions();
		const update = (await request.json()) as TelegramUpdate;
		if (update.callback_query) {
			await handleCallback(update.callback_query);
		} else if (update.message) {
			await handleMessage(update.message);
		}
	} catch (error) {
		console.error('telegram webhook failed', error);
	}

	return json({ ok: true });
};
