import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { specialNotes, rooms, properties } from '$lib/server/db/schema';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { forbidden, landlordOwnsTenant } from '$lib/server/authz';

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');

		const conditions = [];

		if (locals.session?.role === 'TENANT') {
			if (!locals.session.tenantProfileId) return forbidden();
			if (tenantId && tenantId !== locals.session.tenantProfileId) return forbidden();
			conditions.push(eq(specialNotes.tenantId, locals.session.tenantProfileId));
		} else if (locals.session?.role === 'LANDLORD') {
			if (!locals.session.landlordProfileId) return forbidden();
			if (landlordId && landlordId !== locals.session.landlordProfileId) return forbidden();
			conditions.push(
				inArray(
					specialNotes.tenantId,
					db
						.select({ id: rooms.tenantId })
						.from(rooms)
						.innerJoin(properties, eq(rooms.propertyId, properties.id))
						.where(
							and(
								eq(properties.landlordId, locals.session.landlordProfileId),
								isNotNull(rooms.tenantId)
							)
						)
				)
			);
		} else if (landlordId) {
			conditions.push(
				inArray(
					specialNotes.tenantId,
					db
						.select({ id: rooms.tenantId })
						.from(rooms)
						.innerJoin(properties, eq(rooms.propertyId, properties.id))
						.where(and(eq(properties.landlordId, landlordId), isNotNull(rooms.tenantId)))
				)
			);
		} else if (tenantId) {
			conditions.push(eq(specialNotes.tenantId, tenantId));
		}

		if (conditions.length === 0) {
			return json({ error: 'Missing landlordId or tenantId' }, { status: 400 });
		}

		const notes = await db.query.specialNotes.findMany({
			where: and(...conditions),
			with: {
				tenant: {
					with: {
						user: {
							columns: { name: true, phone: true }
						},
						rooms: {
							columns: { roomNumber: true }
						}
					}
				}
			},
			orderBy: desc(specialNotes.createdAt)
		});

		return json(notes);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { tenantId, content, sender } = body;
		const effectiveTenantId =
			locals.session?.role === 'TENANT' ? locals.session.tenantProfileId : tenantId;

		if (!effectiveTenantId || !content) {
			return json({ error: 'Missing tenant ID or content' }, { status: 400 });
		}
		if (
			locals.session?.role === 'TENANT' &&
			tenantId &&
			tenantId !== locals.session.tenantProfileId
		) {
			return forbidden();
		}
		if (
			locals.session?.role === 'LANDLORD' &&
			!(await landlordOwnsTenant(locals.session.landlordProfileId!, effectiveTenantId))
		) {
			return forbidden();
		}
		if (locals.session?.role !== 'TENANT' && locals.session?.role !== 'LANDLORD') {
			return forbidden();
		}

		const created = await db
			.insert(specialNotes)
			.values({
				tenantId: effectiveTenantId,
				content,
				sender:
					locals.session?.role === 'LANDLORD' && sender === 'LANDLORD' ? 'LANDLORD' : 'TENANT',
				isRead: false
			})
			.returning();

		return json(created[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { id, isRead } = body;

		if (!id) {
			return json({ error: 'Missing notification/note ID' }, { status: 400 });
		}

		const note = await db.query.specialNotes.findFirst({
			where: eq(specialNotes.id, id),
			columns: { tenantId: true }
		});
		if (!note) {
			return json({ error: 'Không tìm thấy lời nhắn' }, { status: 404 });
		}
		if (locals.session?.role === 'TENANT' && note.tenantId !== locals.session.tenantProfileId) {
			return forbidden();
		}
		if (
			locals.session?.role === 'LANDLORD' &&
			!(await landlordOwnsTenant(locals.session.landlordProfileId!, note.tenantId))
		) {
			return forbidden();
		}
		if (locals.session?.role !== 'TENANT' && locals.session?.role !== 'LANDLORD') {
			return forbidden();
		}

		const updated = await db
			.update(specialNotes)
			.set({ isRead: isRead !== undefined ? isRead : true })
			.where(eq(specialNotes.id, id))
			.returning();

		return json(updated[0]);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
