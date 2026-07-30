import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { managedTenants } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
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
import { isCommunicationsError } from '$lib/server/communications/errors';
import {
	listMessagesForLandlord,
	listMessagesForStaff,
	listMessagesForTenant,
	sendMessageForLandlord,
	sendMessageForStaff,
	sendMessageForTenant
} from '$lib/server/communications/messages';
import {
	deliverLandlordMessageToTelegram,
	type TelegramDelivery
} from '$lib/server/message-delivery';
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

function readQuery(url: URL) {
	return {
		conversationId: url.searchParams.get('conversationId'),
		managedTenantId: url.searchParams.get('managedTenantId'),
		tenancyId: url.searchParams.get('tenancyId'),
		legacyTenantProfileId: url.searchParams.get('tenantId'),
		cursor: url.searchParams.get('cursor'),
		limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : null
	};
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const query = readQuery(url);

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			return json(await listMessagesForTenant(db, tenant.value, query));
		}

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			return json(await listMessagesForLandlord(db, landlord.value, query));
		}

		const staff = requireStaffActor(guard.actor);
		if (staff.ok) {
			return json(await listMessagesForStaff(db, staff.value, query));
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

		const body = await request.json();
		const content = typeof body.content === 'string' ? body.content.trim() : '';
		if (!content) {
			return json({ error: 'Thiếu thông tin tin nhắn' }, { status: 400 });
		}

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			const { message } = await sendMessageForTenant(db, tenant.value, {
				conversationId: body.conversationId,
				managedTenantId: body.managedTenantId,
				tenancyId: body.tenancyId,
				content
			});
			return json({ ...message, telegramDelivery: null });
		}

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			const { message, conversation } = await sendMessageForLandlord(db, landlord.value, {
				managedTenantId: body.managedTenantId,
				legacyTenantProfileId: body.tenantId,
				tenancyId: body.tenancyId,
				content
			});

			let telegramDelivery: TelegramDelivery | null = null;
			const managedTenant = await db.query.managedTenants.findFirst({
				where: eq(managedTenants.id, conversation.managedTenantId),
				columns: { legacyTenantProfileId: true }
			});
			try {
				telegramDelivery = await deliverLandlordMessageToTelegram({
					landlordId: conversation.landlordId,
					tenantId: managedTenant?.legacyTenantProfileId ?? '',
					messageId: message.id,
					content
				});
			} catch (deliveryError) {
				childRequestLogger(locals.requestId, { route: '/api/messages' }).error(
					{
						event: 'telegram_delivery_failed_after_message_saved',
						landlordId: conversation.landlordId,
						managedTenantId: conversation.managedTenantId,
						messageId: message.id,
						err: deliveryError
					},
					'Telegram delivery failed after message was saved'
				);
				telegramDelivery = {
					status: 'failed',
					delivered: false,
					code: 'delivery_error',
					message: 'Tin đã lưu nhưng không ghi được trạng thái gửi Telegram',
					retryable: true
				};
			}

			return json({ ...message, telegramDelivery });
		}

		const staff = requireStaffActor(guard.actor);
		if (staff.ok) {
			const { message, conversation } = await sendMessageForStaff(db, staff.value, {
				managedTenantId: body.managedTenantId,
				legacyTenantProfileId: body.tenantId,
				tenancyId: body.tenancyId,
				content
			});

			let telegramDelivery: TelegramDelivery | null = null;
			const managedTenant = await db.query.managedTenants.findFirst({
				where: eq(managedTenants.id, conversation.managedTenantId),
				columns: { legacyTenantProfileId: true }
			});
			try {
				telegramDelivery = await deliverLandlordMessageToTelegram({
					landlordId: conversation.landlordId,
					tenantId: managedTenant?.legacyTenantProfileId ?? '',
					messageId: message.id,
					content
				});
			} catch (deliveryError) {
				childRequestLogger(locals.requestId, { route: '/api/messages' }).error(
					{
						event: 'telegram_delivery_failed_after_message_saved',
						landlordId: conversation.landlordId,
						managedTenantId: conversation.managedTenantId,
						messageId: message.id,
						err: deliveryError
					},
					'Telegram delivery failed after message was saved'
				);
				telegramDelivery = {
					status: 'failed',
					delivered: false,
					code: 'delivery_error',
					message: 'Tin đã lưu nhưng không ghi được trạng thái gửi Telegram',
					retryable: true
				};
			}

			return json({ ...message, telegramDelivery });
		}

		return operationalWrongRoleResponse(guard.actor);
	} catch (error) {
		return mapCommunicationsError(error);
	}
};
