import { json } from '@sveltejs/kit';

type Bucket = {
	count: number;
	resetAt: number;
};

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): Response | null {
	const now = Date.now();
	const bucket = buckets.get(key);

	if (!bucket || bucket.resetAt <= now) {
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		return null;
	}

	if (bucket.count >= limit) {
		const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
		return json(
			{ error: 'Thao tác quá nhanh, vui lòng thử lại sau ít phút' },
			{ status: 429, headers: { 'Retry-After': String(retryAfter) } }
		);
	}

	bucket.count += 1;
	return null;
}
