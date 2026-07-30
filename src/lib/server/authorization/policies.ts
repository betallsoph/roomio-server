import type { ActorContext, LandlordActor, StaffActor, TenantActor } from './actor.js';
import {
	type AuthorizationAction,
	type AuthorizationResource,
	type AuthorizeDenyReason,
	type AuthorizeResult,
	resolveStaffCapabilityRequirement,
	staffHasPropertyReadCapability,
	staffRequiresActiveTenancy,
	staffServiceReadCapability,
	type PolicyContext,
	type TenancyStatus
} from './capabilities.js';
import { authorizationErrorToResponse, forbiddenError, unauthenticatedError } from './errors.js';
import { staffHasCapability, staffHasProperty } from './staff-scope.js';

/**
 * AUTH-008 — pure policy evaluation (no DB).
 * Scoped SQL helpers consume the same resource/action vocabulary in scoped-queries.
 */

export type { AuthorizationAction, AuthorizationResource, AuthorizeResult, PolicyContext };

/** Landlord, staff, or tenant — excludes machine and super-admin operational denial. */
export type OperationalUserActor = LandlordActor | StaffActor | TenantActor;

/**
 * Endpoint/scoped-query boundary guard: rejects machine actors and super-admin specifically.
 * Do not use generic isUserActor — that still admits SUPER_ADMIN.
 */
export function isOperationalUserActor(actor: ActorContext): actor is OperationalUserActor {
	if (actor.kind !== 'USER') {
		return false;
	}
	return actor.role !== 'SUPER_ADMIN';
}

/** Pre-authorize actor kind/role before policy evaluation or scoped SQL. */
export function operationalActorDenyReason(actor: ActorContext): AuthorizeDenyReason | null {
	if (actor.kind !== 'USER') {
		return 'WRONG_ACTOR_KIND';
	}
	if (actor.role === 'SUPER_ADMIN') {
		return 'SUPER_ADMIN_OPERATIONAL';
	}
	return null;
}

export type OperationalActorGuardResult =
	| { ok: true; actor: OperationalUserActor }
	| { ok: false; response: Response };

/**
 * Route boundary: null/missing actor → 401; authenticated SUPER_ADMIN on operational routes → 403.
 */
export function guardOperationalUserActor(
	actor: ActorContext | null | undefined
): OperationalActorGuardResult {
	if (!actor) {
		return { ok: false, response: authorizationErrorToResponse(unauthenticatedError()) };
	}
	if (operationalActorDenyReason(actor) === 'SUPER_ADMIN_OPERATIONAL') {
		return {
			ok: false,
			response: authorizationErrorToResponse(forbiddenError('Không có quyền truy cập dữ liệu này'))
		};
	}
	if (!isOperationalUserActor(actor)) {
		return { ok: false, response: authorizationErrorToResponse(unauthenticatedError()) };
	}
	return { ok: true, actor };
}

function deny(reason: AuthorizeDenyReason): AuthorizeResult {
	return { ok: false, reason };
}

function allow(): AuthorizeResult {
	return { ok: true };
}

function landlordOwnsResource(actor: LandlordActor, context: PolicyContext): boolean {
	return actor.landlordId === context.resource.landlordId;
}

function staffAssignedToProperty(actor: StaffActor, context: PolicyContext): boolean {
	const propertyId = context.resource.propertyId;
	if (!propertyId) return false;
	return staffHasProperty(actor, propertyId);
}

function staffSameLandlord(actor: StaffActor, context: PolicyContext): boolean {
	return actor.landlordId === context.resource.landlordId;
}

function tenancyIsActive(status: TenancyStatus | undefined): boolean {
	return status === 'ACTIVE';
}

function tenantClaimsManagedTenant(actor: TenantActor, context: PolicyContext): boolean {
	const managedTenantId = context.resource.managedTenantId;
	if (!managedTenantId) return false;
	if (context.resource.claimedByUserId === actor.userId) return true;
	const tenantScope = context.tenant;
	if (!tenantScope) return false;
	return tenantScope.claimedManagedTenantIds.includes(managedTenantId);
}

function tenantOwnsTenancy(context: PolicyContext): boolean {
	const tenancyId = context.resource.tenancyId;
	if (!tenancyId || !context.tenant) return false;
	return context.tenant.tenancyIds.includes(tenancyId);
}

function tenantHasActiveTenancy(context: PolicyContext): boolean {
	const tenancyId = context.resource.tenancyId;
	if (!tenancyId || !context.tenant) return false;
	const activeIds = context.tenant.activeTenancyIds ?? context.tenant.tenancyIds;
	return activeIds.includes(tenancyId) && tenancyIsActive(context.resource.tenancyStatus);
}

function evaluateStaffPolicy(
	actor: StaffActor,
	resource: AuthorizationResource,
	action: AuthorizationAction,
	context: PolicyContext
): AuthorizeResult {
	if (!staffSameLandlord(actor, context)) {
		return deny('STAFF_PROPERTY');
	}

	const requirement = resolveStaffCapabilityRequirement(resource, action);
	if (requirement.kind === 'DENY') {
		return deny('DEFAULT_DENY');
	}

	if (requirement.kind === 'PROPERTY_READ') {
		if (!staffAssignedToProperty(actor, context)) {
			return deny('STAFF_PROPERTY');
		}
		if (!staffHasPropertyReadCapability(actor.permissions)) {
			return deny('STAFF_CAPABILITY');
		}
		return allow();
	}

	if (requirement.kind === 'SERVICE_READ') {
		if (!staffAssignedToProperty(actor, context)) {
			return deny('STAFF_PROPERTY');
		}
		const serviceCap = staffServiceReadCapability(actor.permissions);
		if (!serviceCap) {
			return deny('STAFF_CAPABILITY');
		}
		return allow();
	}

	if (requirement.kind === 'CAPABILITY') {
		if (!staffAssignedToProperty(actor, context)) {
			return deny('STAFF_PROPERTY');
		}
		if (!staffHasCapability(actor, requirement.permission)) {
			return deny('STAFF_CAPABILITY');
		}
		if (
			staffRequiresActiveTenancy(resource, action) &&
			!tenancyIsActive(context.resource.tenancyStatus)
		) {
			return deny('STAFF_TENANCY_STATUS');
		}
		return allow();
	}

	return deny('DEFAULT_DENY');
}

function evaluateLandlordPolicy(
	actor: LandlordActor,
	resource: AuthorizationResource,
	action: AuthorizationAction,
	context: PolicyContext
): AuthorizeResult {
	if (!landlordOwnsResource(actor, context)) {
		return deny('LANDLORD_SCOPE');
	}

	switch (resource) {
		case 'property':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'delete':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'room':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'delete':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'managedTenant':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'archive':
				case 'invite':
				case 'revoke':
					return allow();
				case 'claim':
					return deny('DEFAULT_DENY');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'tenancy':
			switch (action) {
				case 'list':
				case 'detail':
				case 'start':
				case 'cancel':
				case 'end':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'contract':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'terminate':
				case 'delete':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'invoice':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'approve':
				case 'send':
				case 'void':
				case 'delete':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'paymentAccount':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'delete':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'meter':
			switch (action) {
				case 'list':
				case 'detail':
				case 'submit':
				case 'approve':
				case 'reject':
				case 'update':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'request':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'assign':
				case 'delete':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'asset':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'delete':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'service':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'delete':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'conversation':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
					return allow();
				default:
					return deny('DEFAULT_DENY');
			}
		case 'file':
			// DATA-002 — TenantFile schema/helpers not production-ready; fail closed.
			return deny('DEFAULT_DENY');
		default: {
			const _exhaustive: never = resource;
			return _exhaustive;
		}
	}
}

function evaluateTenantPolicy(
	actor: TenantActor,
	resource: AuthorizationResource,
	action: AuthorizationAction,
	context: PolicyContext
): AuthorizeResult {
	switch (resource) {
		case 'property':
			switch (action) {
				case 'detail':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'room':
			switch (action) {
				case 'detail':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'managedTenant':
			switch (action) {
				case 'list':
				case 'detail':
					return tenantClaimsManagedTenant(actor, context) ? allow() : deny('TENANT_CLAIM');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'tenancy':
			switch (action) {
				case 'list':
				case 'detail':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'contract':
			switch (action) {
				case 'list':
				case 'detail':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'invoice':
			switch (action) {
				case 'list':
				case 'detail':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'paymentAccount':
			switch (action) {
				case 'list':
				case 'detail':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'meter':
			switch (action) {
				case 'list':
				case 'detail':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				case 'submit':
					return tenantHasActiveTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'request':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
					return tenantHasActiveTenancy(context) ? allow() : deny('TENANT_SCOPE');
				case 'update':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'asset':
			// AUTH-013 — RoomAsset has no tenancy handover link; no trusted tenant scoped SQL yet.
			return deny('DEFAULT_DENY');
		case 'service':
			switch (action) {
				case 'list':
				case 'detail':
					return tenantOwnsTenancy(context) ? allow() : deny('TENANT_SCOPE');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'conversation':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
					return tenantClaimsManagedTenant(actor, context) ? allow() : deny('TENANT_CLAIM');
				default:
					return deny('DEFAULT_DENY');
			}
		case 'file':
			// DATA-002 — fileVisibility missing/undefined must not allow; foundation denies all file actions.
			// Re-open only with production TenantFile + visibility-aware scoped helpers.
			return deny('DEFAULT_DENY');
		default: {
			const _exhaustive: never = resource;
			return _exhaustive;
		}
	}
}

/**
 * Authorize a user actor against a resource/action with pre-resolved scope context.
 * Machine actors are denied here — machine routes use channel-specific guards.
 */
export function authorizeActor(
	actor: ActorContext,
	resource: AuthorizationResource,
	action: AuthorizationAction,
	context: PolicyContext
): AuthorizeResult {
	const actorDeny = operationalActorDenyReason(actor);
	if (actorDeny) {
		return deny(actorDeny);
	}
	if (!isOperationalUserActor(actor)) {
		return deny('DEFAULT_DENY');
	}

	switch (actor.role) {
		case 'LANDLORD':
			return evaluateLandlordPolicy(actor, resource, action, context);
		case 'STAFF':
			return evaluateStaffPolicy(actor, resource, action, context);
		case 'TENANT':
			return evaluateTenantPolicy(actor, resource, action, context);
		default: {
			const _exhaustive: never = actor;
			return _exhaustive;
		}
	}
}
