import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { messages } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';

// Hội thoại 1-1 giữa chủ nhà và khách thuê
function conversationId(landlordId: string, tenantId: string) {
	return `${landlordId}_${tenantId}`;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');

		if (!landlordId || !tenantId) {
			return json({ error: 'Missing landlordId or tenantId' }, { status: 400 });
		}

		// Khách chỉ xem được hội thoại của chính mình (chủ nhà đã được hooks kiểm tra landlordId)
		if (locals.session?.role === 'TENANT' && tenantId !== locals.session.tenantProfileId) {
			return json({ error: 'Không có quyền xem hội thoại này' }, { status: 403 });
		}

		const result = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId(landlordId, tenantId)))
			.orderBy(asc(messages.createdAt))
			.limit(500);

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { landlordId, tenantId, content } = body;

		if (!landlordId || !tenantId || !content?.trim()) {
			return json({ error: 'Thiếu thông tin tin nhắn' }, { status: 400 });
		}

		if (locals.session?.role === 'TENANT' && tenantId !== locals.session.tenantProfileId) {
			return json({ error: 'Không có quyền gửi vào hội thoại này' }, { status: 403 });
		}
		if (locals.session?.role === 'LANDLORD' && landlordId !== locals.session.landlordProfileId) {
			return json({ error: 'Không có quyền gửi vào hội thoại này' }, { status: 403 });
		}

		const created = await db
			.insert(messages)
			.values({
				conversationId: conversationId(landlordId, tenantId),
				senderId: locals.session!.userId,
				content: content.trim()
			})
			.returning();

		return json(created[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
