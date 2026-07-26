import { pool } from './index';

let closing: Promise<void> | null = null;

export async function closeDbPool(): Promise<void> {
	if (closing) return closing;

	closing = pool
		.end()
		.then(() => undefined)
		.catch((error: unknown) => {
			closing = null;
			throw error;
		});

	return closing;
}

export function resetDbPoolCloseStateForTests(): void {
	closing = null;
}
