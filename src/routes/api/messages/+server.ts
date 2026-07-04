import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { messages, notificationQueue } from '$lib/server/db/schema';
import { forbidden, landlordOwnsTenant } from '$lib/server/authz';
import {
	deliverLandlordMessageToTelegram,
	type TelegramDelivery
} from '$lib/server/message-delivery';
import { and, asc, eq, inArray } from 'drizzle-orm';

// Hội thoại 1-1 giữa chủ nhà và khách thuê
function conversationId(landlordId: string, tenantId: string) {
	return `${landlordId}_${tenantId}`;
}

function sessionLandlordId(session: App.Locals['session']) {
	if (session?.role === 'LANDLORD') return session.landlordProfileId;
	if (session?.role === 'STAFF') return session.staffLandlordId;
	return null;
}

async function authorizeConversation(
	session: App.Locals['session'],
	landlordId: string,
	tenantId: string
) {
	if (!session?.userId) {
		return json({ error: 'Vui lòng đăng nhập' }, { status: 401 });
	}

	if (session.role === 'TENANT' && tenantId !== session.tenantProfileId) {
		return json({ error: 'Không có quyền truy cập hội thoại này' }, { status: 403 });
	}

	const landlordProfileId = sessionLandlordId(session);
	if (landlordProfileId && landlordId !== landlordProfileId) {
		return json({ error: 'Không có quyền truy cập hội thoại này' }, { status: 403 });
	}

	if (session.role !== 'TENANT' && !landlordProfileId) {
		return json({ error: 'Không có quyền truy cập hội thoại này' }, { status: 403 });
	}

	if (!(await landlordOwnsTenant(landlordId, tenantId))) {
		return forbidden('Hội thoại không thuộc nhà trọ này');
	}

	return null;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');

		if (!landlordId || !tenantId) {
			return json({ error: 'Missing landlordId or tenantId' }, { status: 400 });
		}

		const authError = await authorizeConversation(locals.session, landlordId, tenantId);
		if (authError) return authError;

		const result = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId(landlordId, tenantId)))
			.orderBy(asc(messages.createdAt))
			.limit(500);

		const messageIds = result.map((message) => message.id);
		const deliveries =
			messageIds.length === 0
				? []
				: await db
						.select({
							id: notificationQueue.id,
							relatedId: notificationQueue.relatedId,
							status: notificationQueue.status,
							attemptCount: notificationQueue.attemptCount,
							lastError: notificationQueue.lastError,
							sentAt: notificationQueue.sentAt
						})
						.from(notificationQueue)
						.where(
							and(
								eq(notificationQueue.channel, 'telegram'),
								eq(notificationQueue.relatedType, 'message'),
								inArray(notificationQueue.relatedId, messageIds)
							)
						);
		const deliveryByMessageId = new Map(
			deliveries.map((delivery) => [delivery.relatedId, delivery])
		);

		return json(
			result.map((message) => {
				const delivery = deliveryByMessageId.get(message.id);
				return {
					...message,
					telegramDelivery: delivery
						? {
								notificationId: delivery.id,
								status: delivery.status,
								attemptCount: delivery.attemptCount,
								lastError: delivery.lastError,
								sentAt: delivery.sentAt
							}
						: null
				};
			})
		);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const landlordId = typeof body.landlordId === 'string' ? body.landlordId : '';
		const tenantId = typeof body.tenantId === 'string' ? body.tenantId : '';
		const content = typeof body.content === 'string' ? body.content.trim() : '';

		if (!landlordId || !tenantId || !content) {
			return json({ error: 'Thiếu thông tin tin nhắn' }, { status: 400 });
		}

		const authError = await authorizeConversation(locals.session, landlordId, tenantId);
		if (authError) return authError;

		const created = await db
			.insert(messages)
			.values({
				conversationId: conversationId(landlordId, tenantId),
				senderId: locals.session!.userId,
				content
			})
			.returning();

		let telegramDelivery: TelegramDelivery | null = null;
		if (locals.session?.role !== 'TENANT') {
			try {
				telegramDelivery = await deliverLandlordMessageToTelegram({
					landlordId,
					tenantId,
					messageId: created[0].id,
					content
				});
			} catch (deliveryError) {
				console.error('Telegram delivery failed after message was saved', deliveryError);
				telegramDelivery = {
					status: 'failed',
					delivered: false,
					code: 'delivery_error',
					message: 'Tin đã lưu nhưng không ghi được trạng thái gửi Telegram',
					retryable: true
				};
			}
		}

		return json({ ...created[0], telegramDelivery });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
