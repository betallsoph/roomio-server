import path from 'node:path';
import type { db as AppDb } from '$lib/server/db';
import type { OperationalUserActor } from '$lib/server/authorization/policies';
import {
	findManagedTenantForLandlord,
	findManagedTenantForTenant,
	findMaintenanceRequestForLandlord,
	findMaintenanceRequestForStaff,
	findMaintenanceRequestForTenantHistory,
	findMeterReadingForLandlord,
	findMeterReadingForStaff,
	findMeterReadingForTenantHistory,
	ScopedResourceNotFoundError
} from '$lib/server/authorization/scoped-queries';
import { isLandlordActor, isStaffActor, isTenantActor } from '$lib/server/property-scope/actor';
import { R2_UPLOAD_PURPOSES } from '$lib/server/r2';
import { FileAccessDeniedError } from './policy.js';

export type UploadResourceType =
	| 'managedTenant'
	| 'maintenanceRequest'
	| 'meterReading'
	| 'roomAsset';

export type UploadResourceContext = {
	resourceType: UploadResourceType;
	resourceId: string;
	managedTenantId?: string;
	tenancyId?: string;
};

export type UploadScopeDb = Pick<typeof AppDb, 'query' | 'select'>;

const PURPOSE_RESOURCE: Record<string, UploadResourceType> = {
	'tenant-document': 'managedTenant',
	'maintenance-request': 'maintenanceRequest',
	'meter-reading': 'meterReading',
	'room-asset': 'roomAsset'
};

const SAFE_OBJECT_KEY =
	/^uploads\/[a-z0-9-]+\/[a-z0-9-]+\/[a-zA-Z0-9-]+\/\d{4}\/\d{2}\/[a-f0-9-]+\.(jpg|png|webp|pdf)$/;

export function normalizeUploadPurpose(value: unknown): string {
	const purpose = typeof value === 'string' ? value.trim() : '';
	if (!R2_UPLOAD_PURPOSES.includes(purpose)) {
		throw new FileAccessDeniedError(
			`Loại upload không hợp lệ. Hỗ trợ: ${R2_UPLOAD_PURPOSES.join(', ')}`
		);
	}
	return purpose;
}

export function parseUploadResourceContext(body: unknown, purpose: string): UploadResourceContext {
	const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const resourceTypeRaw =
		typeof payload.resourceType === 'string' ? payload.resourceType.trim() : '';
	const resourceId = typeof payload.resourceId === 'string' ? payload.resourceId.trim() : '';
	const managedTenantId =
		typeof payload.managedTenantId === 'string' ? payload.managedTenantId.trim() : undefined;
	const tenancyId = typeof payload.tenancyId === 'string' ? payload.tenancyId.trim() : undefined;

	const expectedType = PURPOSE_RESOURCE[purpose];
	if (!expectedType) {
		throw new FileAccessDeniedError('Loại upload chưa hỗ trợ resource context');
	}
	if (resourceTypeRaw !== expectedType) {
		throw new FileAccessDeniedError(`resourceType phải là ${expectedType}`);
	}
	if (!resourceId) {
		throw new FileAccessDeniedError('Thiếu resourceId');
	}

	return {
		resourceType: expectedType,
		resourceId,
		managedTenantId,
		tenancyId
	};
}

export async function authorizeUploadResourceContext(
	database: UploadScopeDb,
	actor: OperationalUserActor,
	context: UploadResourceContext
): Promise<{ landlordId: string }> {
	switch (context.resourceType) {
		case 'managedTenant': {
			if (isLandlordActor(actor)) {
				const row = await findManagedTenantForLandlord(database, actor, context.resourceId);
				return { landlordId: row.landlordId };
			}
			if (isTenantActor(actor)) {
				const row = await findManagedTenantForTenant(database, actor, context.resourceId);
				return { landlordId: row.landlordId };
			}
			throw new FileAccessDeniedError();
		}
		case 'maintenanceRequest': {
			if (isLandlordActor(actor)) {
				const row = await findMaintenanceRequestForLandlord(database, actor, context.resourceId);
				if (!row.landlordId) throw new FileAccessDeniedError();
				return { landlordId: row.landlordId };
			}
			if (isStaffActor(actor)) {
				const row = await findMaintenanceRequestForStaff(database, actor, context.resourceId);
				if (!row.landlordId) throw new FileAccessDeniedError();
				return { landlordId: row.landlordId };
			}
			if (isTenantActor(actor)) {
				if (!context.managedTenantId || !context.tenancyId) {
					throw new FileAccessDeniedError('Thiếu managedTenantId/tenancyId');
				}
				const row = await findMaintenanceRequestForTenantHistory(
					database,
					actor,
					{
						managedTenantId: context.managedTenantId,
						tenancyId: context.tenancyId
					},
					context.resourceId
				);
				if (!row.landlordId) throw new FileAccessDeniedError();
				return { landlordId: row.landlordId };
			}
			throw new FileAccessDeniedError();
		}
		case 'meterReading': {
			if (isLandlordActor(actor)) {
				const row = await findMeterReadingForLandlord(database, actor, context.resourceId);
				if (!row.landlordId) throw new FileAccessDeniedError();
				return { landlordId: row.landlordId };
			}
			if (isStaffActor(actor)) {
				const row = await findMeterReadingForStaff(database, actor, context.resourceId);
				if (!row.landlordId) throw new FileAccessDeniedError();
				return { landlordId: row.landlordId };
			}
			if (isTenantActor(actor)) {
				if (!context.managedTenantId || !context.tenancyId) {
					throw new FileAccessDeniedError('Thiếu managedTenantId/tenancyId');
				}
				const row = await findMeterReadingForTenantHistory(
					database,
					actor,
					{
						managedTenantId: context.managedTenantId,
						tenancyId: context.tenancyId
					},
					context.resourceId
				);
				if (!row.landlordId) throw new FileAccessDeniedError();
				return { landlordId: row.landlordId };
			}
			throw new FileAccessDeniedError();
		}
		case 'roomAsset':
			if (!isLandlordActor(actor) && !isStaffActor(actor)) {
				throw new FileAccessDeniedError();
			}
			throw new FileAccessDeniedError('room-asset upload chưa hỗ trợ resource context');
		default: {
			const _exhaustive: never = context.resourceType;
			throw _exhaustive;
		}
	}
}

export function assertSafeLocalFileName(name: string): void {
	if (name.includes('..') || name.includes('/') || name.includes('\\')) {
		throw new FileAccessDeniedError('Tên file không hợp lệ');
	}
	const normalized = path.basename(name);
	if (normalized !== name) {
		throw new FileAccessDeniedError('Tên file không hợp lệ');
	}
}

export function assertSafeObjectKey(objectKey: string): void {
	if (objectKey.includes('..') || objectKey.startsWith('/')) {
		throw new FileAccessDeniedError('Object key không hợp lệ');
	}
	if (!SAFE_OBJECT_KEY.test(objectKey)) {
		throw new FileAccessDeniedError('Object key không hợp lệ');
	}
}

export function mapUploadScopeError(error: unknown): never {
	if (error instanceof FileAccessDeniedError) {
		throw error;
	}
	if (error instanceof ScopedResourceNotFoundError) {
		throw new FileAccessDeniedError();
	}
	throw error;
}
