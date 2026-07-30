import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { supportContacts } from '$lib/server/db/schema';
import { errorMessage } from '$lib/server/api';
import { requireLandlordActor } from '$lib/server/authorization/actor';
import { authorizationErrorToResponse } from '$lib/server/authorization/errors';
import {
	toSupportContactLandlordDto,
	toSupportContactLandlordListDto,
	toSupportContactTenantListDto
} from '$lib/server/dto/support-contact';
import {
	isTenantActor,
	loadTenantActiveTenancies,
	requireLandlordMutationActor,
	requireOperationalActor,
	tenantLandlordIds
} from '$lib/server/property-scope';

const CONTACT_CATEGORIES = [
	'repair',
	'plumbing',
	'electrical',
	'internet',
	'cleaning',
	'emergency',
	'ambulance',
	'fire',
	'security',
	'other'
];

function cleanText(value: unknown, maxLength: number) {
	if (typeof value !== 'string') return null;
	const cleaned = value.trim().slice(0, maxLength);
	return cleaned || null;
}

function cleanRequiredText(value: unknown, maxLength: number) {
	return cleanText(value, maxLength);
}

function cleanCategory(value: unknown) {
	const category = cleanText(value, 40) ?? 'other';
	return CONTACT_CATEGORIES.includes(category) ? category : 'other';
}

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		if (isTenantActor(actorResult.actor)) {
			const active = await loadTenantActiveTenancies(db, actorResult.actor);
			const landlordIds = tenantLandlordIds(active);
			const contacts = await db
				.select()
				.from(supportContacts)
				.where(
					and(inArray(supportContacts.landlordId, landlordIds), eq(supportContacts.isActive, true))
				)
				.orderBy(
					desc(supportContacts.isPinned),
					asc(supportContacts.category),
					asc(supportContacts.name)
				);
			return json(toSupportContactTenantListDto(contacts));
		}

		const landlordGuard = requireLandlordActor(actorResult.actor);
		if (!landlordGuard.ok) {
			return authorizationErrorToResponse(landlordGuard.error);
		}

		const contacts = await db
			.select()
			.from(supportContacts)
			.where(eq(supportContacts.landlordId, landlordGuard.value.landlordId))
			.orderBy(
				desc(supportContacts.isPinned),
				desc(supportContacts.isActive),
				asc(supportContacts.category),
				asc(supportContacts.name)
			);

		return json(toSupportContactLandlordListDto(contacts));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const body = await request.json();
		const name = cleanRequiredText(body.name, 120);
		const phone = cleanRequiredText(body.phone, 40);
		if (!name || !phone) {
			return json({ error: 'Cần nhập tên liên hệ và số điện thoại' }, { status: 400 });
		}

		const created = (
			await db
				.insert(supportContacts)
				.values({
					landlordId: actorResult.actor.landlordId,
					category: cleanCategory(body.category),
					name,
					phone,
					secondaryPhone: cleanText(body.secondaryPhone, 40),
					company: cleanText(body.company, 120),
					serviceArea: cleanText(body.serviceArea, 160),
					notes: cleanText(body.notes, 500),
					isPinned: Boolean(body.isPinned),
					isActive: body.isActive === undefined ? true : Boolean(body.isActive)
				})
				.returning()
		)[0];

		return json(toSupportContactLandlordDto(created), { status: 201 });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const body = await request.json();
		const id = cleanRequiredText(body.id, 80);
		if (!id) return json({ error: 'Thiếu mã liên hệ' }, { status: 400 });

		const existing = await db.query.supportContacts.findFirst({
			where: and(
				eq(supportContacts.id, id),
				eq(supportContacts.landlordId, actorResult.actor.landlordId)
			)
		});
		if (!existing) return json({ error: 'Không tìm thấy liên hệ' }, { status: 404 });

		const updateData: Partial<typeof supportContacts.$inferInsert> = {};
		if (body.category !== undefined) updateData.category = cleanCategory(body.category);
		if (body.name !== undefined) {
			const name = cleanRequiredText(body.name, 120);
			if (!name) return json({ error: 'Tên liên hệ không được để trống' }, { status: 400 });
			updateData.name = name;
		}
		if (body.phone !== undefined) {
			const phone = cleanRequiredText(body.phone, 40);
			if (!phone) return json({ error: 'Số điện thoại không được để trống' }, { status: 400 });
			updateData.phone = phone;
		}
		if (body.secondaryPhone !== undefined)
			updateData.secondaryPhone = cleanText(body.secondaryPhone, 40);
		if (body.company !== undefined) updateData.company = cleanText(body.company, 120);
		if (body.serviceArea !== undefined) updateData.serviceArea = cleanText(body.serviceArea, 160);
		if (body.notes !== undefined) updateData.notes = cleanText(body.notes, 500);
		if (body.isPinned !== undefined) updateData.isPinned = Boolean(body.isPinned);
		if (body.isActive !== undefined) updateData.isActive = Boolean(body.isActive);

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'Chưa có thông tin cần cập nhật' }, { status: 400 });
		}

		const updated = (
			await db.update(supportContacts).set(updateData).where(eq(supportContacts.id, id)).returning()
		)[0];

		return json(toSupportContactLandlordDto(updated));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const actorResult = requireLandlordMutationActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const id = cleanRequiredText(url.searchParams.get('id'), 80);
		if (!id) return json({ error: 'Thiếu mã liên hệ' }, { status: 400 });

		const existing = await db.query.supportContacts.findFirst({
			where: and(
				eq(supportContacts.id, id),
				eq(supportContacts.landlordId, actorResult.actor.landlordId)
			)
		});
		if (!existing) return json({ error: 'Không tìm thấy liên hệ' }, { status: 404 });

		await db.delete(supportContacts).where(eq(supportContacts.id, id));
		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
