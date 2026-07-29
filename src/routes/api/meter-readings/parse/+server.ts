import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errorMessage } from '$lib/server/api';
import { parseMeterReadingFromImageUrl } from '$lib/server/meter-ocr';
import { isOcrConfigured } from '$lib/server/env';
import { requireLandlordActor, requireTenantActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	unauthenticatedError
} from '$lib/server/authorization/errors';
import { operationalActorDenyReason } from '$lib/server/authorization/policies';
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
			return authorizationErrorToResponse(unauthenticatedError());
		}

		if (!isOcrConfigured()) {
			return json({ error: 'OCR chưa được cấu hình' }, { status: 503 });
		}

		const body = await request.json();
		const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl.trim() : '';
		if (!photoUrl) {
			return json({ error: 'Thiếu URL ảnh' }, { status: 400 });
		}

		const result = await parseMeterReadingFromImageUrl(photoUrl);
		return json(toMeterOcrDto(result));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
