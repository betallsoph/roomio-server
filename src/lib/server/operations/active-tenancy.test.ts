import assert from 'node:assert/strict';
import test from 'node:test';
import type { TenantActor } from '../authorization/actor.js';
import { isOperationsError } from './errors.js';
import { resolveTenancyForTenantMutation } from './active-tenancy.js';

type MockTenancyRow = {
	managedTenantId: string;
	tenancyId: string;
	landlordId: string;
	propertyId: string;
	roomId: string;
	tenantProfileId: string | null;
	propertyName: string;
	roomNumber: string;
	status: string;
};

const tenantActor: TenantActor = {
	kind: 'USER',
	userId: 'user-multi-claim',
	role: 'TENANT',
	tenantProfileId: 'tp-multi-claim'
};

function activeRow(overrides: Partial<MockTenancyRow> & Pick<MockTenancyRow, 'tenancyId' | 'roomId'>) {
	return {
		managedTenantId: overrides.managedTenantId ?? `mt-${overrides.tenancyId}`,
		tenancyId: overrides.tenancyId,
		landlordId: overrides.landlordId ?? 'landlord-a',
		propertyId: overrides.propertyId ?? `prop-${overrides.roomId}`,
		roomId: overrides.roomId,
		tenantProfileId: overrides.tenantProfileId ?? tenantActor.tenantProfileId,
		propertyName: overrides.propertyName ?? 'Property',
		roomNumber: overrides.roomNumber ?? '101',
		status: overrides.status ?? 'ACTIVE'
	};
}

/** Minimal drizzle-shaped mock: claimedTenancyQuery(...).where(...) resolves to preset rows. */
function mockTenancyDb(rows: MockTenancyRow[]) {
	const queryTail = { where: async () => rows };
	const joinTail = { innerJoin: () => joinTail, ...queryTail };
	const fromTail = { from: () => joinTail };
	return { select: () => fromTail };
}

test('resolveTenancyForTenantMutation returns 422 when user has multiple ACTIVE claims and no target', async () => {
	const db = mockTenancyDb([
		activeRow({ tenancyId: 'ten-1', roomId: 'room-a1' }),
		activeRow({ tenancyId: 'ten-2', roomId: 'room-a2' })
	]);

	await assert.rejects(
		() => resolveTenancyForTenantMutation(db, tenantActor, {}),
		(error: unknown) => {
			assert.equal(isOperationsError(error), true);
			const opsError = error as { status: number; message: string };
			assert.equal(opsError.status, 422);
			assert.equal(
				opsError.message,
				'Cần chỉ rõ tenancyId hoặc roomId khi có nhiều lần thuê đang hiệu lực'
			);
			return true;
		}
	);
});

test('resolveTenancyForTenantMutation returns 422 when multiple ACTIVE tenancies share the same roomId', async () => {
	const db = mockTenancyDb([
		activeRow({ tenancyId: 'ten-1', roomId: 'room-shared' }),
		activeRow({ tenancyId: 'ten-2', roomId: 'room-shared' })
	]);

	await assert.rejects(
		() => resolveTenancyForTenantMutation(db, tenantActor, { roomId: 'room-shared' }),
		(error: unknown) => {
			assert.equal(isOperationsError(error), true);
			const opsError = error as { status: number; message: string };
			assert.equal(opsError.status, 422);
			assert.equal(
				opsError.message,
				'Nhiều lần thuê ACTIVE cho cùng phòng — cần tenancyId rõ ràng'
			);
			return true;
		}
	);
});
