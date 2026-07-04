import { db } from '$lib/server/db';
import { notificationQueue, tenantProfiles } from '$lib/server/db/schema';
import {
	buildTenantDirectMessageText,
	sendTelegramMessage,
	type TelegramSendResult
} from '$lib/server/telegram-bot';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

const MAX_MANUAL_RETRY_BATCH = 25;

function today() {
	return new Date().toISOString().split('T')[0];
}

function nextAttemptAt(result: Extract<TelegramSendResult, { ok: false }>) {
	if (!result.retryable) return null;
	const delaySeconds = result.retryAfterSeconds ?? 60;
	return new Date(Date.now() + delaySeconds * 1000);
}

type TelegramFailureCode = Extract<TelegramSendResult, { ok: false }>['code'] | 'delivery_error';
type NotificationDelivery = typeof notificationQueue.$inferSelect;

export type TelegramDelivery =
	| {
			status: 'sent';
			delivered: true;
			notificationId: string;
			telegramMessageId: number | null;
	  }
	| {
			status: 'queued';
			delivered: false;
			notificationId: string;
			message: string;
	  }
	| {
			status: 'failed';
			delivered: false;
			notificationId?: string;
			code: TelegramFailureCode;
			message: string;
			retryable: boolean;
	  }
	| {
			status: 'skipped';
			delivered: false;
			code: 'tenant_not_linked' | 'tenant_missing';
			message: string;
	  };

export async function deliverLandlordMessageToTelegram(args: {
	landlordId: string;
	tenantId: string;
	messageId: string;
	content: string;
}): Promise<TelegramDelivery> {
	const tenant = await db.query.tenantProfiles.findFirst({
		where: eq(tenantProfiles.id, args.tenantId),
		columns: { id: true, userId: true, telegramUserId: true }
	});

	if (!tenant) {
		return {
			status: 'skipped',
			delivered: false,
			code: 'tenant_missing',
			message: 'Không tìm thấy hồ sơ khách thuê'
		};
	}
	if (!tenant.telegramUserId) {
		return {
			status: 'skipped',
			delivered: false,
			code: 'tenant_not_linked',
			message: 'Khách chưa liên kết Telegram'
		};
	}

	const [queued] = await db
		.insert(notificationQueue)
		.values({
			landlordId: args.landlordId,
			tenantId: tenant.id,
			recipientUserId: tenant.userId,
			type: 'direct_message',
			channel: 'telegram',
			title: 'Tin nhắn mới từ chủ trọ',
			content: args.content,
			status: 'queued',
			attemptCount: 0,
			relatedType: 'message',
			relatedId: args.messageId,
			scheduledFor: today()
		})
		.returning();

	queueTelegramNotificationSend(queued);

	return {
		status: 'queued',
		delivered: false,
		notificationId: queued.id,
		message: 'Tin đã xếp hàng gửi Telegram'
	};
}

function buildTelegramText(notification: NotificationDelivery) {
	if (notification.type === 'direct_message') {
		return buildTenantDirectMessageText(notification.content);
	}
	return buildTenantDirectMessageText(notification.content);
}

async function markTelegramDeliveryFailed(
	notification: NotificationDelivery,
	result: Extract<TelegramSendResult, { ok: false }>
): Promise<TelegramDelivery> {
	const attemptCount = notification.attemptCount + 1;
	await db
		.update(notificationQueue)
		.set({
			status: 'failed',
			attemptCount,
			lastError: result.message,
			nextAttemptAt: nextAttemptAt(result)
		})
		.where(eq(notificationQueue.id, notification.id));

	return {
		status: 'failed',
		delivered: false,
		notificationId: notification.id,
		code: result.code,
		message: result.message,
		retryable: result.retryable
	};
}

function queueTelegramNotificationSend(notification: NotificationDelivery) {
	void sendQueuedTelegramNotification(notification).catch(async (error) => {
		console.error('Queued Telegram delivery crashed', error);
		await markTelegramDeliveryFailed(notification, {
			ok: false,
			code: 'network',
			message: error instanceof Error ? error.message : 'Không chạy được delivery Telegram',
			retryable: true
		}).catch((markError) => {
			console.error('Failed to mark queued Telegram delivery as failed', markError);
		});
	});
}

export async function sendQueuedTelegramNotification(
	notification: NotificationDelivery
): Promise<TelegramDelivery> {
	if (notification.channel !== 'telegram') {
		return {
			status: 'failed',
			delivered: false,
			notificationId: notification.id,
			code: 'delivery_error',
			message: 'Delivery này không phải kênh Telegram',
			retryable: false
		};
	}
	if (notification.status === 'sent') {
		return {
			status: 'sent',
			delivered: true,
			notificationId: notification.id,
			telegramMessageId: notification.providerMessageId
				? Number(notification.providerMessageId)
				: null
		};
	}

	if (!notification.tenantId) {
		return markTelegramDeliveryFailed(notification, {
			ok: false,
			code: 'bad_request',
			message: 'Delivery thiếu tenantId',
			retryable: false
		});
	}

	const tenant = await db.query.tenantProfiles.findFirst({
		where: eq(tenantProfiles.id, notification.tenantId),
		columns: { telegramUserId: true }
	});

	if (!tenant?.telegramUserId) {
		return markTelegramDeliveryFailed(notification, {
			ok: false,
			code: 'bad_request',
			message: 'Khách chưa liên kết Telegram',
			retryable: false
		});
	}

	const result = await sendTelegramMessage(tenant.telegramUserId, buildTelegramText(notification));

	if (result.ok) {
		await db
			.update(notificationQueue)
			.set({
				status: 'sent',
				attemptCount: notification.attemptCount + 1,
				lastError: null,
				providerMessageId:
					result.telegramMessageId === null ? null : String(result.telegramMessageId),
				nextAttemptAt: null,
				sentAt: new Date()
			})
			.where(eq(notificationQueue.id, notification.id));
		return {
			status: 'sent',
			delivered: true,
			notificationId: notification.id,
			telegramMessageId: result.telegramMessageId
		};
	}

	return markTelegramDeliveryFailed(notification, result);
}

export async function listTelegramDeliveries(landlordId: string, limit = 20) {
	return db.query.notificationQueue.findMany({
		where: and(
			eq(notificationQueue.landlordId, landlordId),
			eq(notificationQueue.channel, 'telegram'),
			inArray(notificationQueue.status, ['queued', 'failed'])
		),
		with: {
			tenant: {
				with: {
					user: { columns: { name: true, phone: true } },
					rooms: { columns: { roomNumber: true } }
				}
			}
		},
		orderBy: [desc(notificationQueue.createdAt)],
		limit
	});
}

export async function retryTelegramDelivery(landlordId: string, notificationId: string) {
	const notification = await db.query.notificationQueue.findFirst({
		where: and(
			eq(notificationQueue.id, notificationId),
			eq(notificationQueue.landlordId, landlordId),
			eq(notificationQueue.channel, 'telegram')
		)
	});

	if (!notification) {
		return null;
	}
	return sendQueuedTelegramNotification(notification);
}

export async function retryPendingTelegramDeliveries(landlordId: string, limit = 10) {
	const cappedLimit = Math.min(Math.max(limit, 1), MAX_MANUAL_RETRY_BATCH);
	const rows = await db.query.notificationQueue.findMany({
		where: and(
			eq(notificationQueue.landlordId, landlordId),
			eq(notificationQueue.channel, 'telegram'),
			inArray(notificationQueue.status, ['queued', 'failed'])
		),
		orderBy: [asc(notificationQueue.createdAt)],
		limit: cappedLimit
	});

	const results = [];
	for (const row of rows) {
		results.push({ id: row.id, result: await sendQueuedTelegramNotification(row) });
	}

	return results;
}
