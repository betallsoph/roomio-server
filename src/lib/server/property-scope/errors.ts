import { json } from '@sveltejs/kit';
import { AuthorizationError, authorizationErrorToResponse } from '$lib/server/authorization/errors';
import { ScopedResourceNotFoundError } from '$lib/server/authorization/scoped-queries';

/** Map scoped-query / authorization failures to HTTP responses (§12.2). */
export function propertyScopeErrorToResponse(error: unknown): Response | null {
	if (error instanceof ScopedResourceNotFoundError) {
		return json({ error: error.message }, { status: 404 });
	}
	if (error instanceof AuthorizationError) {
		return authorizationErrorToResponse(error);
	}
	return null;
}
