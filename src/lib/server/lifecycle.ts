import { closeDbPool } from '$lib/server/db/shutdown';
import { getLogger, getReleaseSha } from '$lib/server/logger';
import { getEnv } from '$lib/server/env';

let lifecycleRegistered = false;

export function registerProcessLifecycle(): void {
	if (lifecycleRegistered) return;
	lifecycleRegistered = true;

	const env = getEnv();
	getLogger().info({
		event: 'startup',
		release: getReleaseSha(),
		environment: env.nodeEnv
	});

	process.once('sveltekit:shutdown', (reason: string) => {
		void handleShutdown(reason);
	});
}

export async function handleShutdown(reason: string): Promise<void> {
	getLogger().info({
		event: 'shutdown',
		reason,
		release: getReleaseSha()
	});

	await closeDbPool();
}

export function resetLifecycleForTests(): void {
	lifecycleRegistered = false;
	process.removeAllListeners('sveltekit:shutdown');
}
