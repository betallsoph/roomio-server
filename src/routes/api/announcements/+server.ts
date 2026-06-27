import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { announcements, blocks, rooms } from '$lib/server/db/schema';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import {
	forbidden,
	landlordOwnsProperty,
	landlordOwnsRoom,
	landlordOwnsTenant,
	requireLandlord
} from '$lib/server/authz';

async function landlordOwnsBlock(landlordId: string, blockId: string) {
	const row = await db.query.blocks.findFirst({
		where: eq(blocks.id, blockId),
		with: { property: { columns: { landlordId: true } } }
	});
	return row?.property.landlordId === landlordId;
}

async function landlordOwnsAnnouncement(landlordUserId: string, announcementId: string) {
	const announcement = await db.query.announcements.findFirst({
		where: and(eq(announcements.id, announcementId), eq(announcements.senderId, landlordUserId)),
		columns: { id: true }
	});
	return !!announcement;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const senderId = url.searchParams.get('senderId');
		const targetType = url.searchParams.get('targetType');
		const targetId = url.searchParams.get('targetId');

		// Chế độ dành cho khách thuê: gom mọi thông báo nhắm tới họ
		// (toàn hệ thống, tòa nhà, block, phòng hoặc đích danh khách)
		const audience = url.searchParams.get('audience');

		if (locals.session?.role === 'TENANT' || audience === 'tenant') {
			const tenantId = locals.session?.tenantProfileId;
			if (!tenantId) return forbidden();
			const room = await db.query.rooms.findFirst({
				where: eq(rooms.tenantId, tenantId),
				columns: { id: true, propertyId: true, blockId: true, tenantId: true }
			});

			const targets = [and(eq(announcements.targetType, 'ALL'), isNull(announcements.targetId))];
			if (room?.propertyId)
				targets.push(
					and(eq(announcements.targetType, 'PROPERTY'), eq(announcements.targetId, room.propertyId))
				);
			if (room?.blockId)
				targets.push(
					and(eq(announcements.targetType, 'BLOCK'), eq(announcements.targetId, room.blockId))
				);
			if (room?.id)
				targets.push(
					and(eq(announcements.targetType, 'ROOM'), eq(announcements.targetId, room.id))
				);
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
		if (locals.session?.role === 'LANDLORD') {
			conditions.push(eq(announcements.senderId, locals.session.userId));
		} else if (senderId) {
			conditions.push(eq(announcements.senderId, senderId));
		}
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

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const { title, content, isImportant, targetType, targetId } = body;

		if (!title || !content) {
			return json({ error: 'Missing required announcement fields' }, { status: 400 });
		}
		if (
			targetType === 'PROPERTY' &&
			targetId &&
			!(await landlordOwnsProperty(auth.value, targetId))
		) {
			return forbidden();
		}
		if (targetType === 'BLOCK' && targetId && !(await landlordOwnsBlock(auth.value, targetId))) {
			return forbidden();
		}
		if (targetType === 'ROOM' && targetId && !(await landlordOwnsRoom(auth.value, targetId))) {
			return forbidden();
		}
		if (targetType === 'TENANT' && targetId && !(await landlordOwnsTenant(auth.value, targetId))) {
			return forbidden();
		}

		const created = await db
			.insert(announcements)
			.values({
				senderId: locals.session!.userId,
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

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing announcement ID' }, { status: 400 });
		}
		if (
			locals.session?.role !== 'LANDLORD' ||
			!(await landlordOwnsAnnouncement(locals.session.userId, id))
		) {
			return forbidden();
		}

		await db.delete(announcements).where(eq(announcements.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
