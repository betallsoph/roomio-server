import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Health check cho nginx / load balancer
export const GET: RequestHandler = () => json({ ok: true, service: 'roomio-api' });
