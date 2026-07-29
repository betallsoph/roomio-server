import type { StaffPermission } from './actor.js';

/**
 * AUTH-008 — resource/action vocabulary and staff capability gates.
 * Pure types and capability resolution; scoped SQL lives in scoped-queries (Composer 4).
 */

export const AUTHORIZATION_RESOURCES = [
	'property',
	'room',
	'managedTenant',
	'tenancy',
	'invoice',
	'contract',
	'meter',
	'request',
	'asset',
	'service',
	'paymentAccount',
	'conversation',
	'file'
] as const;

export type AuthorizationResource = (typeof AUTHORIZATION_RESOURCES)[number];

export const AUTHORIZATION_ACTIONS = [
	'list',
	'detail',
	'create',
	'update',
	'delete',
	'archive',
	'start',
	'cancel',
	'end',
	'terminate',
	'submit',
	'approve',
	'reject',
	'send',
	'void',
	'assign',
	'claim',
	'invite',
	'revoke'
] as const;

export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

export type TenancyStatus = 'ACTIVE' | 'ENDED' | 'CANCELLED';

export type FileVisibility = 'LANDLORD_ONLY' | 'TENANT_CAN_VIEW';

/** Snapshot scope for the resource being authorized (no DB lookups). */
export type PolicyResourceScope = {
	landlordId: string;
	propertyId?: string;
	managedTenantId?: string;
	tenancyId?: string;
	claimedByUserId?: string | null;
	tenancyStatus?: TenancyStatus;
	fileVisibility?: FileVisibility;
};

/** Tenant actor scope carried alongside the resource snapshot. */
export type TenantPolicyScope = {
	claimedManagedTenantIds: readonly string[];
	tenancyIds: readonly string[];
	activeTenancyIds?: readonly string[];
};

export type PolicyContext = {
	resource: PolicyResourceScope;
	tenant?: TenantPolicyScope;
};

export type AuthorizeDenyReason =
	| 'DEFAULT_DENY'
	| 'WRONG_ACTOR_KIND'
	| 'SUPER_ADMIN_OPERATIONAL'
	| 'LANDLORD_SCOPE'
	| 'STAFF_PROPERTY'
	| 'STAFF_CAPABILITY'
	| 'STAFF_TENANCY_STATUS'
	| 'TENANT_CLAIM'
	| 'TENANT_SCOPE'
	| 'TENANT_VISIBILITY';

export type AuthorizeResult =
	| { ok: true }
	| { ok: false; reason: AuthorizeDenyReason };

/**
 * Staff capabilities that imply assigned-property operational access (§6.2 matrix).
 * Property/room reads accept VIEW_ROOMS or any of these when staff is assigned.
 */
export const STAFF_PROPERTY_READ_CAPABILITIES: readonly StaffPermission[] = [
	'VIEW_ROOMS',
	'VIEW_TENANTS',
	'MANAGE_METERS',
	'MANAGE_REQUESTS'
];

/** Result of resolving staff capability for a resource/action pair. */
export type StaffCapabilityRequirement =
	| { kind: 'DENY' }
	| { kind: 'CAPABILITY'; permission: StaffPermission }
	| { kind: 'PROPERTY_READ' }
	| { kind: 'PROPERTY_ASSIGNMENT_ONLY' };

function denyStaff(): StaffCapabilityRequirement {
	return { kind: 'DENY' };
}

function capability(permission: StaffPermission): StaffCapabilityRequirement {
	return { kind: 'CAPABILITY', permission };
}

/**
 * Exhaustive staff capability gate per §6.2 / AUTH-008 matrix.
 * Default branch denies — TypeScript must stay exhaustive when unions grow.
 */
export function resolveStaffCapabilityRequirement(
	resource: AuthorizationResource,
	action: AuthorizationAction
): StaffCapabilityRequirement {
	switch (resource) {
		case 'property':
			switch (action) {
				case 'list':
				case 'detail':
					return { kind: 'PROPERTY_READ' };
				default:
					return denyStaff();
			}
		case 'room':
			switch (action) {
				case 'list':
				case 'detail':
					return { kind: 'PROPERTY_READ' };
				default:
					return denyStaff();
			}
		case 'managedTenant':
			switch (action) {
				case 'list':
				case 'detail':
					return capability('VIEW_TENANTS');
				default:
					return denyStaff();
			}
		case 'tenancy':
			switch (action) {
				case 'list':
				case 'detail':
					return capability('VIEW_TENANTS');
				default:
					return denyStaff();
			}
		case 'meter':
			switch (action) {
				case 'list':
				case 'detail':
				case 'submit':
				case 'approve':
				case 'reject':
				case 'update':
					return capability('MANAGE_METERS');
				default:
					return denyStaff();
			}
		case 'request':
			switch (action) {
				case 'list':
				case 'detail':
				case 'create':
				case 'update':
				case 'assign':
					return capability('MANAGE_REQUESTS');
				default:
					return denyStaff();
			}
		case 'asset':
			switch (action) {
				case 'list':
				case 'detail':
					return capability('VIEW_ROOMS');
				default:
					return denyStaff();
			}
		case 'service':
			switch (action) {
				case 'list':
				case 'detail':
					return { kind: 'PROPERTY_ASSIGNMENT_ONLY' };
				default:
					return denyStaff();
			}
		case 'invoice':
		case 'contract':
		case 'paymentAccount':
		case 'conversation':
		case 'file':
			return denyStaff();
		default: {
			const _exhaustive: never = resource;
			return _exhaustive;
		}
	}
}

/** Service catalog read: assigned + VIEW_ROOMS or MANAGE_METERS (§6.2). */
export function staffServiceReadCapability(
	permissions: readonly StaffPermission[]
): StaffPermission | null {
	if (permissions.includes('VIEW_ROOMS')) return 'VIEW_ROOMS';
	if (permissions.includes('MANAGE_METERS')) return 'MANAGE_METERS';
	return null;
}

export function staffHasPropertyReadCapability(permissions: readonly StaffPermission[]): boolean {
	return STAFF_PROPERTY_READ_CAPABILITIES.some((permission) => permissions.includes(permission));
}

export function staffRequiresActiveTenancy(
	resource: AuthorizationResource,
	action: AuthorizationAction
): boolean {
	switch (resource) {
		case 'managedTenant':
			return action === 'list' || action === 'detail';
		case 'tenancy':
			return action === 'list' || action === 'detail';
		default:
			return false;
	}
}
