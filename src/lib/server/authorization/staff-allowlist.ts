/**
 * AUTH-005 / AUTH-010 — temporary outer STAFF URL gate in hooks.
 * Assignment/capability checks live in DB/ActorContext; endpoint SQL scoping is AUTH-008.
 */

export type StaffAllowlistRule = {
	prefix: string;
	methods: readonly string[];
};

export const STAFF_ALLOWLIST: readonly StaffAllowlistRule[] = [
	{ prefix: '/api/requests', methods: ['GET', 'PUT'] },
	{ prefix: '/api/meter-readings', methods: ['GET', 'PUT'] },
	{ prefix: '/api/rooms', methods: ['GET'] },
	{ prefix: '/api/properties', methods: ['GET'] },
	{ prefix: '/api/services', methods: ['GET'] },
	{ prefix: '/api/tenants', methods: ['GET'] },
	{ prefix: '/api/upload', methods: ['POST'] },
	{ prefix: '/api/uploads/presign', methods: ['POST'] }
];

function pathnameMatchesStaffAllowlistPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isStaffRouteAllowed(method: string, pathname: string): boolean {
	return STAFF_ALLOWLIST.some(
		(rule) =>
			pathnameMatchesStaffAllowlistPrefix(pathname, rule.prefix) && rule.methods.includes(method)
	);
}
