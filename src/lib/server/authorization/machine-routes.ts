/**
 * Exact session-exempt API routes (method + pathname).
 *
 * Registry membership only skips the hooks.session gate — it does NOT authenticate
 * the caller. MACHINE routes must verify secrets, signatures, or other credentials
 * inside their handlers.
 */

export type PublicRouteKind = 'USER_PUBLIC' | 'MACHINE';

export type PublicRouteEntry = {
	kind: PublicRouteKind;
	note?: string;
};

export function publicRouteKey(method: string, pathname: string): string {
	return `${method.toUpperCase()} ${pathname}`;
}

export const PUBLIC_ROUTE_REGISTRY: ReadonlyMap<string, PublicRouteEntry> = new Map([
	[publicRouteKey('POST', '/api/auth'), { kind: 'USER_PUBLIC' }],
	[publicRouteKey('POST', '/api/auth/telegram'), { kind: 'USER_PUBLIC' }],
	[
		publicRouteKey('POST', '/api/payment-webhook'),
		{ kind: 'MACHINE', note: 'Handler verifies payment provider signature' }
	],
	[
		publicRouteKey('POST', '/api/payos-webhook'),
		{ kind: 'MACHINE', note: 'Re-exports payment-webhook POST; handler verifies signature' }
	],
	[
		publicRouteKey('POST', '/api/payos-webhook/subscription'),
		{ kind: 'MACHINE', note: 'Handler verifies PayOS subscription webhook' }
	],
	[
		publicRouteKey('POST', '/api/telegram/webhook'),
		{ kind: 'MACHINE', note: 'Handler verifies Telegram secret token' }
	],
	[
		publicRouteKey('POST', '/api/cron/monthly'),
		{ kind: 'MACHINE', note: 'Handler verifies x-cron-secret === CRON_SECRET' }
	]
]);

export function isSessionExemptPublicRoute(method: string, pathname: string): boolean {
	return PUBLIC_ROUTE_REGISTRY.has(publicRouteKey(method, pathname));
}

/** Sorted registry keys for tests and diagnostics. */
export function listPublicRouteKeys(): string[] {
	return [...PUBLIC_ROUTE_REGISTRY.keys()].sort();
}
