import { json } from '@sveltejs/kit';
import {
	requireLandlordActor,
	type ActorContext,
	type LandlordActor
} from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	unauthenticatedError
} from '$lib/server/authorization/errors';

export type LandlordActorResult =
	| { ok: true; actor: LandlordActor }
	| { ok: false; response: Response };

/**
 * AUTH-005 — ActorContext only. Never trust locals.session as authority for staff APIs.
 */
export function resolveLandlordActorFromRequest(input: {
	actor: ActorContext | null | undefined;
}): LandlordActorResult {
	if (!input.actor) {
		return { ok: false, response: authorizationErrorToResponse(unauthenticatedError()) };
	}
	const guard = requireLandlordActor(input.actor);
	if (!guard.ok) {
		return { ok: false, response: authorizationErrorToResponse(guard.error) };
	}
	return { ok: true, actor: guard.value };
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
