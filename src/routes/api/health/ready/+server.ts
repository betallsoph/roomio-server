import { json } from '@sveltejs/kit';
import { checkDatabaseReady, readyHealthBody } from '$lib/server/health';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const ready = await checkDatabaseReady();
	const body = readyHealthBody(ready);
	return json(body, { status: ready ? 200 : 503 });
};
