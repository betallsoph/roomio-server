// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { ActorContext } from '$lib/server/authorization/actor';
import type { SessionData } from '$lib/server/session';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			session: SessionData | null;
			actor: ActorContext | null;
			requestId: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
