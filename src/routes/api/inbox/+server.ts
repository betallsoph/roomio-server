import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { requireLandlord } from '$lib/server/authz';
import { getCentralInbox } from '$lib/server/automation';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		return json(await getCentralInbox(auth.value));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
