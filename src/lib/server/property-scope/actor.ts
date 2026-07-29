import {
	requireLandlordActor,
	type ActorContext,
	type LandlordActor,
	type StaffActor,
	type TenantActor
} from '$lib/server/authorization/actor';
import type { OperationalUserActor } from '$lib/server/authorization/policies';
import {
	authorizationErrorToResponse,
	forbiddenError,
	unauthenticatedError
} from '$lib/server/authorization/errors';
import { operationalActorDenyReason } from '$lib/server/authorization/policies';

export type OperationalActorResult =
	| { ok: true; actor: OperationalUserActor }
	| { ok: false; response: Response };

export type LandlordMutationResult =
	| { ok: true; actor: LandlordActor }
	| { ok: false; response: Response };

/** Require landlord, staff, or tenant actor from `locals.actor` — never session fields. */
export function requireOperationalActor(
	actor: ActorContext | null | undefined
): OperationalActorResult {
	if (!actor) {
		return { ok: false, response: authorizationErrorToResponse(unauthenticatedError()) };
	}
	const deny = operationalActorDenyReason(actor);
	if (deny) {
		return { ok: false, response: authorizationErrorToResponse(forbiddenError()) };
	}
	return { ok: true, actor: actor as OperationalUserActor };
}

/** Landlord-only mutations (create/update/delete property tree). */
export function requireLandlordMutationActor(
	actor: ActorContext | null | undefined
): LandlordMutationResult {
	if (!actor) {
		return { ok: false, response: authorizationErrorToResponse(unauthenticatedError()) };
	}
	const guard = requireLandlordActor(actor);
	if (!guard.ok) {
		return { ok: false, response: authorizationErrorToResponse(guard.error) };
	}
	return { ok: true, actor: guard.value };
}

export function isLandlordActor(actor: OperationalUserActor): actor is LandlordActor {
	return actor.role === 'LANDLORD';
}

export function isStaffActor(actor: OperationalUserActor): actor is StaffActor {
	return actor.role === 'STAFF';
}

export function isTenantActor(actor: OperationalUserActor): actor is TenantActor {
	return actor.role === 'TENANT';
}
