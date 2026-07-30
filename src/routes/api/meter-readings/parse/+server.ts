import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errorMessage } from '$lib/server/api';
import { db } from '$lib/server/db';
import { parseMeterReadingFromImageUrl } from '$lib/server/meter-ocr';
import { isOcrConfigured } from '$lib/server/env';
import { requireLandlordActor, requireTenantActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	unauthenticatedError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { operationalActorDenyReason } from '$lib/server/authorization/policies';
import { authorizeMeterServiceForActor } from '$lib/server/operations/meter-readings';
import { isOperationsError } from '$lib/server/operations/errors';
import { toMeterOcrDto } from '$lib/server/dto/meter-ocr';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const actor = locals.actor;
		if (!actor || operationalActorDenyReason(actor)) {
			return authorizationErrorToResponse(unauthenticatedError());
		}

		const tenant = requireTenantActor(actor);
		const landlord = requireLandlordActor(actor);
		if (!tenant.ok && !landlord.ok) {
			if (actor.kind === 'USER') {
				return authorizationErrorToResponse(
					wrongRoleError('Không có quyền thực hiện thao tác này')
				);
			}
			return authorizationErrorToResponse(unauthenticatedError());
		}

		const body = await request.json();
		const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
		const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
		const tenancyId = typeof body.tenancyId === 'string' ? body.tenancyId.trim() : '';
		const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl.trim() : '';

		if (!roomId || !serviceId || !photoUrl) {
			return json({ error: 'Thiếu roomId, serviceId hoặc URL ảnh' }, { status: 400 });
		}

		if (tenant.ok) {
			await authorizeMeterServiceForActor(db, tenant.value, roomId, serviceId, tenancyId || null);
		} else if (landlord.ok) {
			await authorizeMeterServiceForActor(db, landlord.value, roomId, serviceId);
		}

		if (!isOcrConfigured()) {
			return json({ error: 'OCR chưa được cấu hình' }, { status: 503 });
		}

		const result = await parseMeterReadingFromImageUrl(photoUrl);
		return json(toMeterOcrDto(result));
	} catch (error) {
		if (isOperationsError(error)) {
			return json({ error: error.message }, { status: error.status });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
