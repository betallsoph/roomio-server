import { json } from '@sveltejs/kit';
import { liveHealthBody } from '$lib/server/health';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json(liveHealthBody());
