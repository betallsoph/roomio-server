import { closeDbPool } from '$lib/server/db/shutdown';
import { getEnv } from '$lib/server/env';

function getReleaseSha(): string {
	return (
		process.env.RELEASE_SHA?.trim() ||
		process.env.GITHUB_SHA?.trim() ||
		process.env.COMMIT_SHA?.trim() ||
		'unknown'
	);
}

let lifecycleRegistered = false;

export function registerProcessLifecycle(): void {
	if (lifecycleRegistered) return;
	lifecycleRegistered = true;

	const env = getEnv();
	console.log(
		JSON.stringify({
			event: 'startup',
			service: 'roomio-api',
			release: getReleaseSha(),
			environment: env.nodeEnv
		})
	);

	process.once('sveltekit:shutdown', (reason: string) => {
		void handleShutdown(reason);
	});
}

export async function handleShutdown(reason: string): Promise<void> {
	console.log(
		JSON.stringify({
			event: 'shutdown',
			service: 'roomio-api',
			reason,
			release: getReleaseSha()
		})
	);

	await closeDbPool();
}

export function resetLifecycleForTests(): void {
	lifecycleRegistered = false;
	process.removeAllListeners('sveltekit:shutdown');
}
