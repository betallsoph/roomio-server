import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { messages, notificationQueue } from '$lib/server/db/schema';
import type { LandlordActor, StaffActor, TenantActor } from '$lib/server/authorization/actor';
import {
	findOrCreateConversationForLandlord,
	findOrCreateConversationForStaff,
	resolveConversationForLandlordSide,
	resolveConversationForTenant,
	type ResolvedConversation
} from './conversations.js';
import { communicationsNotFound, communicationsValidation, type CommunicationsDb } from './errors.js';

export type MessageRow = typeof messages.$inferSelect;

export type MessageWithDelivery = MessageRow & {
	telegramDelivery: {
		notificationId: string;
		status: string;
		attemptCount: number;
		lastError: string | null;
		sentAt: Date | null;
	} | null;
};

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;

function parseLimit(limit?: number | null) {
	if (limit == null || Number.isNaN(limit)) return DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function scopedConversationWhere(conversation: ResolvedConversation) {
	return inArray(messages.conversationId, conversation.messageConversationIds);
}

async function attachTelegramDeliveries(
	database: CommunicationsDb,
	landlordId: string,
	rows: MessageRow[]
): Promise<MessageWithDelivery[]> {
	const messageIds = rows.map((row) => row.id);
	if (messageIds.length === 0) return [];

	const deliveries = await database
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
				eq(notificationQueue.landlordId, landlordId),
				eq(notificationQueue.channel, 'telegram'),
				eq(notificationQueue.relatedType, 'message'),
				inArray(notificationQueue.relatedId, messageIds)
			)
		);

	const deliveryByMessageId = new Map(deliveries.map((delivery) => [delivery.relatedId, delivery]));

	return rows.map((message) => {
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
	});
}

export async function listMessagesForConversation(
	database: CommunicationsDb,
	conversation: ResolvedConversation,
	options: { cursor?: string | null; limit?: number | null } = {}
): Promise<MessageWithDelivery[]> {
	const limit = parseLimit(options.limit);
	const cursor = typeof options.cursor === 'string' ? options.cursor.trim() : '';

	const conditions = [scopedConversationWhere(conversation)];
	if (cursor) {
		const cursorRow = await database.query.messages.findFirst({
			where: and(eq(messages.id, cursor), scopedConversationWhere(conversation)),
			columns: { createdAt: true, id: true }
		});
		if (!cursorRow) throw communicationsNotFound();
		conditions.push(
			or(
				lt(messages.createdAt, cursorRow.createdAt),
				and(eq(messages.createdAt, cursorRow.createdAt), lt(messages.id, cursorRow.id))
			)!
		);
	}

	const rows = await database
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(limit);

	rows.reverse();
	return attachTelegramDeliveries(database, conversation.landlordId, rows);
}

export async function listMessagesForTenant(
	database: CommunicationsDb,
	actor: TenantActor,
	input: {
		conversationId?: string | null;
		managedTenantId?: string | null;
		tenancyId?: string | null;
		cursor?: string | null;
		limit?: number | null;
	}
): Promise<MessageWithDelivery[]> {
	const conversation = await resolveConversationForTenant(database, actor, input);
	return listMessagesForConversation(database, conversation, input);
}

export async function listMessagesForLandlord(
	database: CommunicationsDb,
	actor: LandlordActor,
	input: {
		conversationId?: string | null;
		managedTenantId?: string | null;
		legacyTenantProfileId?: string | null;
		tenancyId?: string | null;
		cursor?: string | null;
		limit?: number | null;
	}
): Promise<MessageWithDelivery[]> {
	const conversation = await resolveConversationForLandlordSide(database, actor, input);
	return listMessagesForConversation(database, conversation, input);
}

export async function listMessagesForStaff(
	database: CommunicationsDb,
	actor: StaffActor,
	input: {
		conversationId?: string | null;
		managedTenantId?: string | null;
		legacyTenantProfileId?: string | null;
		tenancyId?: string | null;
		cursor?: string | null;
		limit?: number | null;
	}
): Promise<MessageWithDelivery[]> {
	const conversation = await resolveConversationForLandlordSide(database, actor, input);
	return listMessagesForConversation(database, conversation, input);
}

export async function sendMessageForLandlord(
	database: CommunicationsDb,
	actor: LandlordActor,
	input: {
		managedTenantId?: string | null;
		legacyTenantProfileId?: string | null;
		tenancyId?: string | null;
		content: string;
	}
): Promise<{ message: MessageRow; conversation: ResolvedConversation }> {
	const content = input.content.trim();
	if (!content) throw communicationsValidation('Thiếu nội dung tin nhắn');

	const conversation = await resolveConversationForLandlordSide(database, actor, input);
	const [created] = await database
		.insert(messages)
		.values({
			conversationId: conversation.id,
			senderId: actor.userId,
			content
		})
		.returning();

	return { message: created, conversation };
}

export async function sendMessageForStaff(
	database: CommunicationsDb,
	actor: StaffActor,
	input: {
		managedTenantId?: string | null;
		legacyTenantProfileId?: string | null;
		tenancyId?: string | null;
		content: string;
	}
): Promise<{ message: MessageRow; conversation: ResolvedConversation }> {
	const content = input.content.trim();
	if (!content) throw communicationsValidation('Thiếu nội dung tin nhắn');

	const conversation = await resolveConversationForLandlordSide(database, actor, input);
	const [created] = await database
		.insert(messages)
		.values({
			conversationId: conversation.id,
			senderId: actor.userId,
			content
		})
		.returning();

	return { message: created, conversation };
}

export async function sendMessageForTenant(
	database: CommunicationsDb,
	actor: TenantActor,
	input: {
		conversationId?: string | null;
		managedTenantId?: string | null;
		tenancyId?: string | null;
		content: string;
	}
): Promise<{ message: MessageRow; conversation: ResolvedConversation }> {
	const content = input.content.trim();
	if (!content) throw communicationsValidation('Thiếu nội dung tin nhắn');

	const conversation = await resolveConversationForTenant(database, actor, input);
	const [created] = await database
		.insert(messages)
		.values({
			conversationId: conversation.id,
			senderId: actor.userId,
			content
		})
		.returning();

	return { message: created, conversation };
}

export {
	findOrCreateConversationForLandlord,
	findOrCreateConversationForStaff
};
