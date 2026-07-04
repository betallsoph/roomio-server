import { db } from '$lib/server/db';
import { notificationQueue, tenantProfiles } from '$lib/server/db/schema';
import {
	buildTenantDirectMessageText,
	sendTelegramMessage,
	type TelegramSendResult
} from '$lib/server/telegram-bot';
import { eq } from 'drizzle-orm';

function today() {
	return new Date().toISOString().split('T')[0];
}

function nextAttemptAt(result: Extract<TelegramSendResult, { ok: false }>) {
	if (!result.retryable) return null;
	const delaySeconds = result.retryAfterSeconds ?? 60;
	return new Date(Date.now() + delaySeconds * 1000);
}

type TelegramFailureCode = Extract<TelegramSendResult, { ok: false }>['code'] | 'delivery_error';

export type TelegramDelivery =
	| {
			status: 'sent';
			delivered: true;
			notificationId: string;
			telegramMessageId: number | null;
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

	const result = await sendTelegramMessage(
		tenant.telegramUserId,
		buildTenantDirectMessageText(args.content)
	);

	if (result.ok) {
		await db
			.update(notificationQueue)
			.set({
				status: 'sent',
				attemptCount: 1,
				lastError: null,
				providerMessageId:
					result.telegramMessageId === null ? null : String(result.telegramMessageId),
				nextAttemptAt: null,
				sentAt: new Date()
			})
			.where(eq(notificationQueue.id, queued.id));
		return {
			status: 'sent',
			delivered: true,
			notificationId: queued.id,
			telegramMessageId: result.telegramMessageId
		};
	}

	await db
		.update(notificationQueue)
		.set({
			status: 'failed',
			attemptCount: 1,
			lastError: result.message,
			nextAttemptAt: nextAttemptAt(result)
		})
		.where(eq(notificationQueue.id, queued.id));

	return {
		status: 'failed',
		delivered: false,
		notificationId: queued.id,
		code: result.code,
		message: result.message,
		retryable: result.retryable
	};
}
