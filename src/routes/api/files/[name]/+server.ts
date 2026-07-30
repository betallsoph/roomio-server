import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	assertTenantFileMetadataAvailable,
	isFileAccessDeniedError
} from '$lib/server/file-access';
import { requireOperationalActor } from '$lib/server/property-scope';

const NAME_PATTERN = /^[a-f0-9-]+\.(jpg|png|webp|pdf)$/;

/** AUTH-011 — fail closed: path/name alone is never sufficient to serve a file. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const actorResult = requireOperationalActor(locals.actor);
	if (!actorResult.ok) return actorResult.response;

	const { name } = params;
	if (!NAME_PATTERN.test(name)) {
		throw error(400, 'Tên file không hợp lệ');
	}

	try {
		assertTenantFileMetadataAvailable();
	} catch (err) {
		if (isFileAccessDeniedError(err)) {
			return json({ error: err.message }, { status: 403 });
		}
		throw err;
	}
};
