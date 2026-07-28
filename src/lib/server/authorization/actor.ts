import {
	forbiddenError,
	wrongActorKindError,
	wrongRoleError,
	type AuthorizationError
} from './errors.js';

/**
 * AUTH-002 — discriminated actor types and role guards.
 * Guards return ActorGuardResult (Result pattern). Convert with authorizationErrorToResponse.
 * No DB access and no cross-request cache in this module.
 */

export type UserRole = 'SUPER_ADMIN' | 'LANDLORD' | 'STAFF' | 'TENANT';

/** AUTH-005 MVP capabilities only — no wildcard; UPLOAD is hook allowlist until AUTH-008. */
export type StaffPermission = 'VIEW_ROOMS' | 'VIEW_TENANTS' | 'MANAGE_METERS' | 'MANAGE_REQUESTS';

export const STAFF_PERMISSIONS = [
	'VIEW_ROOMS',
	'VIEW_TENANTS',
	'MANAGE_METERS',
	'MANAGE_REQUESTS'
] as const satisfies readonly StaffPermission[];

export type MachineChannel = 'PAYMENT_WEBHOOK' | 'TELEGRAM_WEBHOOK' | 'QSTASH' | 'CRON';

export type SuperAdminActor = {
	kind: 'USER';
	userId: string;
	role: 'SUPER_ADMIN';
};

export type LandlordActor = {
	kind: 'USER';
	userId: string;
	role: 'LANDLORD';
	landlordId: string;
};

export type StaffActor = {
	kind: 'USER';
	userId: string;
	role: 'STAFF';
	staffId: string;
	landlordId: string;
	propertyIds: string[];
	permissions: StaffPermission[];
};

export type TenantActor = {
	kind: 'USER';
	userId: string;
	role: 'TENANT';
	tenantProfileId: string;
};

export type UserActor = SuperAdminActor | LandlordActor | StaffActor | TenantActor;

export type MachineActor = {
	kind: 'MACHINE';
	channel: MachineChannel;
	requestId: string;
	verifiedAccountId?: string;
};

export type ActorContext = UserActor | MachineActor;

export type ActorGuardResult<T> = { ok: true; value: T } | { ok: false; error: AuthorizationError };

export function requireRole<const R extends UserRole>(
	actor: ActorContext,
	roles: readonly R[]
): ActorGuardResult<Extract<UserActor, { role: R }>> {
	if (actor.kind !== 'USER') {
		return { ok: false, error: wrongActorKindError() };
	}
	if (!roles.includes(actor.role as R)) {
		return { ok: false, error: forbiddenError() };
	}
	return { ok: true, value: actor as Extract<UserActor, { role: R }> };
}

export function requireSuperAdminActor(actor: ActorContext): ActorGuardResult<SuperAdminActor> {
	if (actor.kind !== 'USER') {
		return { ok: false, error: wrongActorKindError() };
	}
	if (actor.role !== 'SUPER_ADMIN') {
		return { ok: false, error: wrongRoleError('Chỉ Super Admin được phép truy cập') };
	}
	return { ok: true, value: actor };
}

export function requireLandlordActor(actor: ActorContext): ActorGuardResult<LandlordActor> {
	if (actor.kind !== 'USER') {
		return { ok: false, error: wrongActorKindError() };
	}
	if (actor.role !== 'LANDLORD') {
		return { ok: false, error: wrongRoleError('Chỉ chủ trọ được thực hiện thao tác này') };
	}
	return { ok: true, value: actor };
}

export function requireStaffActor(actor: ActorContext): ActorGuardResult<StaffActor> {
	if (actor.kind !== 'USER') {
		return { ok: false, error: wrongActorKindError() };
	}
	if (actor.role !== 'STAFF') {
		return { ok: false, error: wrongRoleError('Chỉ nhân viên được thực hiện thao tác này') };
	}
	return { ok: true, value: actor };
}

export function requireTenantActor(actor: ActorContext): ActorGuardResult<TenantActor> {
	if (actor.kind !== 'USER') {
		return { ok: false, error: wrongActorKindError() };
	}
	if (actor.role !== 'TENANT') {
		return { ok: false, error: wrongRoleError('Chỉ khách thuê được thực hiện thao tác này') };
	}
	return { ok: true, value: actor };
}
