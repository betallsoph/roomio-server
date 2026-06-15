import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { announcements } from '$lib/server/db/schema';
import { and, desc, eq, isNull, or } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const senderId = url.searchParams.get('senderId');
		const targetType = url.searchParams.get('targetType');
		const targetId = url.searchParams.get('targetId');

		// Chế độ dành cho khách thuê: gom mọi thông báo nhắm tới họ
		// (toàn hệ thống, tòa nhà, block, phòng hoặc đích danh khách)
		const audience = url.searchParams.get('audience');

		if (audience === 'tenant') {
			const propertyId = url.searchParams.get('propertyId');
			const blockId = url.searchParams.get('blockId');
			const roomId = url.searchParams.get('roomId');
			const tenantId = url.searchParams.get('tenantId');

			const targets = [and(eq(announcements.targetType, 'ALL'), isNull(announcements.targetId))];
			if (propertyId)
				targets.push(
					and(eq(announcements.targetType, 'PROPERTY'), eq(announcements.targetId, propertyId))
				);
			if (blockId)
				targets.push(
					and(eq(announcements.targetType, 'BLOCK'), eq(announcements.targetId, blockId))
				);
			if (roomId)
				targets.push(and(eq(announcements.targetType, 'ROOM'), eq(announcements.targetId, roomId)));
			if (tenantId)
				targets.push(
					and(eq(announcements.targetType, 'TENANT'), eq(announcements.targetId, tenantId))
				);

			const result = await db
				.select()
				.from(announcements)
				.where(or(...targets))
				.orderBy(desc(announcements.isImportant), desc(announcements.createdAt));

			return json(result);
		}

		const conditions = [];
		if (senderId) conditions.push(eq(announcements.senderId, senderId));
		if (targetType) conditions.push(eq(announcements.targetType, targetType));
		if (targetId) conditions.push(eq(announcements.targetId, targetId));

		const result = await db
			.select()
			.from(announcements)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(announcements.createdAt));

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { senderId, title, content, isImportant, targetType, targetId } = body;

		if (!senderId || !title || !content) {
			return json({ error: 'Missing required announcement fields' }, { status: 400 });
		}

		const created = await db
			.insert(announcements)
			.values({
				senderId,
				title,
				content,
				isImportant: isImportant || false,
				targetType: targetType || 'ALL',
				targetId: targetId || null
			})
			.returning();

		return json(created[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing announcement ID' }, { status: 400 });
		}

		await db.delete(announcements).where(eq(announcements.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
