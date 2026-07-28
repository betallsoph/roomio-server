import { json } from '@sveltejs/kit';
import {
	requireLandlordActor,
	type LandlordActor
} from '$lib/server/authorization/actor';
import { authorizationErrorToResponse } from '$lib/server/authorization/errors';
import type { ActorContext } from '$lib/server/authorization/actor';
import type { SessionData } from '$lib/server/session';

export type LandlordActorResult =
	| { ok: true; actor: LandlordActor }
	| { ok: false; response: Response };

export function resolveLandlordActorFromRequest(input: {
	actor: ActorContext | null;
	session: SessionData | null;
}): LandlordActorResult {
	if (input.actor) {
		const guard = requireLandlordActor(input.actor);
		if (!guard.ok) {
			return { ok: false, response: authorizationErrorToResponse(guard.error) };
		}
		return { ok: true, actor: guard.value };
	}

	if (
		input.session?.role === 'LANDLORD' &&
		input.session.landlordProfileId &&
		input.session.userId
	) {
		return {
			ok: true,
			actor: {
				kind: 'USER',
				userId: input.session.userId,
				role: 'LANDLORD',
				landlordId: input.session.landlordProfileId
			}
		};
	}

	return { ok: false, response: json({ error: 'Chưa đăng nhập' }, { status: 401 }) };
}

export function staffRouteErrorResponse(error: unknown): Response | null {
	if (error && typeof error === 'object' && 'status' in error) {
		const status = (error as { status: number }).status;
		if (status === 404 || status === 422) {
			const message = error instanceof Error ? error.message : 'Yêu cầu không hợp lệ';
			return json({ error: message }, { status });
		}
	}
	return null;
}
