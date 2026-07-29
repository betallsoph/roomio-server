import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SessionData } from '$lib/server/session';
import { getEnv } from '$lib/server/env';
import { users, landlordProfiles, tenantProfiles, staffProfiles } from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import type { ActorContext, StaffPermission } from './actor.js';
import { UnauthorizedError } from './errors.js';
import { loadActiveStaffPermissions, loadActiveStaffPropertyIds } from './staff-scope.js';
import { eq } from 'drizzle-orm';

type DrizzleDb = NodePgDatabase<typeof schema>;

/** USER-kind slice of ActorContext returned by getUserActor. */
export type UserActorContext = Extract<ActorContext, { kind: 'USER' }>;

export type DbUserRow = {
	isActive: boolean;
	role: string;
};

export type LandlordProfileRow = {
	id: string;
};

export type TenantProfileRow = {
	id: string;
};

export type StaffProfileRow = {
	id: string;
	landlordId: string;
};

/**
 * Injectable DB surface for getUserActor. Tests supply a mock; production uses Drizzle.
 * No actor/permission caching — each call performs fresh lookups.
 */
export interface ActorDb {
	findUserById(userId: string): Promise<DbUserRow | null>;
	findLandlordProfileByUserId(userId: string): Promise<LandlordProfileRow | null>;
	findTenantProfileByUserId(userId: string): Promise<TenantProfileRow | null>;
	findStaffProfileByUserId(userId: string): Promise<StaffProfileRow | null>;
	listActiveStaffPropertyIds(staffId: string): Promise<string[]>;
	listActiveStaffPermissions(staffId: string): Promise<StaffPermission[]>;
}

const ENV_FAKE_SUPER_ADMIN_USER_IDS = new Set(['env-super-admin', 'hardcoded-super-admin']);

/** Legacy env-file Super Admin session IDs that must never be trusted as DB authority. */
export function isEnvFakeSuperAdminUserId(userId: string): boolean {
	return ENV_FAKE_SUPER_ADMIN_USER_IDS.has(userId) || userId.startsWith('env-super-admin:');
}

/**
 * True when `session` is a transitional env-file Super Admin cookie that Lane 3
 * (`getActorContext`) may honor outside production. `getUserActor` always rejects
 * these IDs — only DB-backed Super Admin users are loaded here.
 *
 * Requires allowEnvSuperAdmin (NODE_ENV=development + SUPER_ADMIN_ACCOUNTS configured).
 */
export function isTransitionalEnvSuperAdminSession(session: SessionData): boolean {
	const env = getEnv();
	if (env.isProduction) return false;
	if (!env.allowEnvSuperAdmin) return false;
	return session.role === 'SUPER_ADMIN' && isEnvFakeSuperAdminUserId(session.userId);
}

function isEnvFakeSuperAdminSession(session: SessionData): boolean {
	return session.role === 'SUPER_ADMIN' && isEnvFakeSuperAdminUserId(session.userId);
}

function assertNoSessionProfileMismatch(
	sessionValue: string | null | undefined,
	dbValue: string
): void {
	if (sessionValue != null && sessionValue !== dbValue) {
		throw new UnauthorizedError('Quyền truy cập đã thay đổi, vui lòng đăng nhập lại');
	}
}

export function createDrizzleActorDb(database: DrizzleDb): ActorDb {
	return {
		async findUserById(userId) {
			const row = await database.query.users.findFirst({
				where: eq(users.id, userId),
				columns: { isActive: true, role: true }
			});
			return row ?? null;
		},
		async findLandlordProfileByUserId(userId) {
			const row = await database.query.landlordProfiles.findFirst({
				where: eq(landlordProfiles.userId, userId),
				columns: { id: true }
			});
			return row ?? null;
		},
		async findTenantProfileByUserId(userId) {
			const row = await database.query.tenantProfiles.findFirst({
				where: eq(tenantProfiles.userId, userId),
				columns: { id: true }
			});
			return row ?? null;
		},
		async findStaffProfileByUserId(userId) {
			const row = await database.query.staffProfiles.findFirst({
				where: eq(staffProfiles.userId, userId),
				columns: { id: true, landlordId: true }
			});
			return row ?? null;
		},
		async listActiveStaffPropertyIds(staffId) {
			return loadActiveStaffPropertyIds(database, staffId);
		},
		async listActiveStaffPermissions(staffId) {
			return loadActiveStaffPermissions(database, staffId);
		}
	};
}

let cachedDefaultActorDb: ActorDb | null = null;

async function resolveActorDb(actorDb?: ActorDb): Promise<ActorDb> {
	if (actorDb) return actorDb;
	if (!cachedDefaultActorDb) {
		const { db } = await import('$lib/server/db');
		cachedDefaultActorDb = createDrizzleActorDb(db);
	}
	return cachedDefaultActorDb;
}

/**
 * Load a USER-kind ActorContext from the database for the given session.
 * Throws UnauthorizedError when the session must be revoked (caller destroys cookie).
 *
 * Env-fake Super Admin session IDs are always rejected here; use
 * `isTransitionalEnvSuperAdminSession` in Lane 3 if transitional support is needed.
 */
export async function getUserActor(
	session: SessionData,
	actorDb?: ActorDb
): Promise<UserActorContext> {
	if (isEnvFakeSuperAdminSession(session)) {
		throw new UnauthorizedError('Phiên đã hết hiệu lực, vui lòng đăng nhập lại');
	}

	const db = await resolveActorDb(actorDb);
	const account = await db.findUserById(session.userId);

	if (!account || !account.isActive) {
		throw new UnauthorizedError('Phiên đã hết hiệu lực, vui lòng đăng nhập lại');
	}

	if (account.role !== session.role) {
		throw new UnauthorizedError('Quyền truy cập đã thay đổi, vui lòng đăng nhập lại');
	}

	switch (account.role) {
		case 'SUPER_ADMIN':
			return {
				kind: 'USER',
				userId: session.userId,
				role: 'SUPER_ADMIN'
			};

		case 'LANDLORD': {
			const profile = await db.findLandlordProfileByUserId(session.userId);
			if (!profile) {
				throw new UnauthorizedError('Phiên đã hết hiệu lực, vui lòng đăng nhập lại');
			}
			assertNoSessionProfileMismatch(session.landlordProfileId, profile.id);
			return {
				kind: 'USER',
				userId: session.userId,
				role: 'LANDLORD',
				landlordId: profile.id
			};
		}

		case 'TENANT': {
			const profile = await db.findTenantProfileByUserId(session.userId);
			if (!profile) {
				throw new UnauthorizedError('Phiên đã hết hiệu lực, vui lòng đăng nhập lại');
			}
			assertNoSessionProfileMismatch(session.tenantProfileId, profile.id);
			return {
				kind: 'USER',
				userId: session.userId,
				role: 'TENANT',
				tenantProfileId: profile.id
			};
		}

		case 'STAFF': {
			const profile = await db.findStaffProfileByUserId(session.userId);
			if (!profile) {
				throw new UnauthorizedError('Phiên đã hết hiệu lực, vui lòng đăng nhập lại');
			}
			assertNoSessionProfileMismatch(session.staffProfileId, profile.id);
			assertNoSessionProfileMismatch(session.staffLandlordId, profile.landlordId);
			const [propertyIds, permissions] = await Promise.all([
				db.listActiveStaffPropertyIds(profile.id),
				db.listActiveStaffPermissions(profile.id)
			]);
			return {
				kind: 'USER',
				userId: session.userId,
				role: 'STAFF',
				staffId: profile.id,
				landlordId: profile.landlordId,
				propertyIds,
				permissions
			};
		}

		default:
			throw new UnauthorizedError('Phiên đã hết hiệu lực, vui lòng đăng nhập lại');
	}
}
