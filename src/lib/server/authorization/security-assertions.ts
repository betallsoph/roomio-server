import assert from 'node:assert/strict';

/** Forbidden keys in any client API response per §9.3 (authorization-tenancy). */
export const FORBIDDEN_CLIENT_RESPONSE_KEYS: readonly string[] = [
	'passwordHash',
	'payosApiKeyEnc',
	'payosChecksumKeyEnc',
	'rawPayload',
	'sessionSecret',
	'checksumKey',
	'apiKey',
	'inviteToken',
	'tokenHash',
	'sessionVersion',
	'encryptionKey'
];

const FORBIDDEN_KEY_SET = new Set<string>(FORBIDDEN_CLIENT_RESPONSE_KEYS);

export type ForbiddenKeyHit = { path: string; key: string };

/** Recursively collect forbidden keys from nested objects and arrays. */
export function findForbiddenKeys(value: unknown, path = ''): ForbiddenKeyHit[] {
	const hits: ForbiddenKeyHit[] = [];

	if (value === null || value === undefined) return hits;

	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			hits.push(...findForbiddenKeys(value[index], `${path}[${index}]`));
		}
		return hits;
	}

	if (typeof value === 'object') {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			const childPath = path ? `${path}.${key}` : key;
			if (FORBIDDEN_KEY_SET.has(key)) {
				hits.push({ path: childPath, key });
			}
			hits.push(...findForbiddenKeys(child, childPath));
		}
	}

	return hits;
}

/** Assert no §9.3 forbidden keys appear anywhere in a parsed response body. */
export function expectNoForbiddenKeys(body: unknown): void {
	const hits = findForbiddenKeys(body);
	if (hits.length > 0) {
		const summary = hits.map((hit) => `${hit.path} (${hit.key})`).join(', ');
		assert.fail(`Forbidden client response key(s) found per §9.3: ${summary}`);
	}
}

export type ForeignResourceHiddenOptions = {
	/** Resource IDs that must not appear in the serialized response body. */
	sensitiveIds?: string[];
	/** Expected HTTP status for cross-scope access (default 404 per §12.2). */
	status?: number;
};

/**
 * Assert a cross-scope response is hidden: expected status and body does not leak sensitive IDs.
 * Also scans JSON bodies for forbidden keys when parseable.
 */
export async function expectForeignResourceHidden(
	response: Response,
	options: ForeignResourceHiddenOptions = {}
): Promise<void> {
	const status = options.status ?? 404;
	assert.equal(response.status, status);

	const text = await response.text();
	let serialized = text;
	try {
		serialized = JSON.stringify(JSON.parse(text));
	} catch {
		// keep raw text for ID substring scan
	}

	for (const id of options.sensitiveIds ?? []) {
		if (id && serialized.includes(id)) {
			assert.fail(`Foreign resource response leaks sensitive id "${id}" in body`);
		}
	}

	try {
		expectNoForbiddenKeys(JSON.parse(text));
	} catch (error) {
		if (error instanceof SyntaxError) return;
		throw error;
	}
}
