// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { SessionData } from '$lib/server/session';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			session: SessionData | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
