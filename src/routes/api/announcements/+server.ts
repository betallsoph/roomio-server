import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	requireLandlordActor,
	requireStaffActor,
	requireTenantActor
} from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	unauthenticatedError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import {
	createAnnouncementForLandlord,
	deleteAnnouncementForLandlord,
	listAnnouncementsForLandlord,
	listAnnouncementsForStaff,
	listAnnouncementsForTenant
} from '$lib/server/communications/announcements';
import { isCommunicationsError } from '$lib/server/communications/errors';
import { queueAnnouncementTelegramDeliveries } from '$lib/server/message-delivery';
import { childRequestLogger } from '$lib/server/logger';

function mapCommunicationsError(error: unknown) {
	if (isCommunicationsError(error)) {
		return json({ error: error.message }, { status: error.status });
	}
	if (isAuthorizationError(error)) {
		return authorizationErrorToResponse(error);
	}
	return json({ error: errorMessage(error) }, { status: 500 });
}

function operationalWrongRoleResponse(actor: App.Locals['actor']) {
	if (actor?.kind === 'USER') {
		return authorizationErrorToResponse(wrongRoleError('Không có quyền thực hiện thao tác này'));
	}
	return authorizationErrorToResponse(unauthenticatedError());
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const audience = url.searchParams.get('audience');
		const targetType = url.searchParams.get('targetType');
		const targetId = url.searchParams.get('targetId');

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok || audience === 'tenant') {
			if (!tenant.ok) return operationalWrongRoleResponse(guard.actor);
			return json(await listAnnouncementsForTenant(db, tenant.value));
		}

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			return json(
				await listAnnouncementsForLandlord(db, landlord.value, { targetType, targetId })
			);
		}

		const staff = requireStaffActor(guard.actor);
		if (staff.ok) {
			return json(await listAnnouncementsForStaff(db, staff.value, { targetType, targetId }));
		}

		return operationalWrongRoleResponse(guard.actor);
	} catch (error) {
		return mapCommunicationsError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) return operationalWrongRoleResponse(guard.actor);

		const body = await request.json();
		const { title, content, isImportant, targetType, targetId } = body;

		if (!title || !content) {
			return json({ error: 'Missing required announcement fields' }, { status: 400 });
		}

		const created = await createAnnouncementForLandlord(db, landlord.value, {
			title,
			content,
			isImportant,
			targetType,
			targetId
		});

		let telegramDelivery = null;
		try {
			telegramDelivery = await queueAnnouncementTelegramDeliveries({
				landlordId: landlord.value.landlordId,
				announcementId: created.id,
				title,
				content,
				isImportant: !!isImportant,
				targetType: created.targetType,
				targetId: created.targetId
			});
		} catch (deliveryError) {
			childRequestLogger(locals.requestId, { route: '/api/announcements' }).error(
				{
					event: 'telegram_delivery_failed_after_announcement_saved',
					landlordId: landlord.value.landlordId,
					announcementId: created.id,
					targetType: created.targetType,
					targetId: created.targetId,
					err: deliveryError
				},
				'Telegram delivery failed after announcement was saved'
			);
			telegramDelivery = {
				status: 'failed',
				totalRecipients: 0,
				queued: 0,
				skippedUnlinked: 0,
				message: 'Đã đăng thông báo nhưng không tạo được queue Telegram'
			};
		}

		return json({ ...created, telegramDelivery });
	} catch (error) {
		return mapCommunicationsError(error);
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) return operationalWrongRoleResponse(guard.actor);

		const id = url.searchParams.get('id');
		if (!id) {
			return json({ error: 'Missing announcement ID' }, { status: 400 });
		}

		await deleteAnnouncementForLandlord(db, landlord.value, id);
		return json({ success: true });
	} catch (error) {
		return mapCommunicationsError(error);
	}
};
