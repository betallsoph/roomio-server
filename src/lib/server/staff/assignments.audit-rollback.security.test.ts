import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb
} from '../testing/test-db.js';
import { seedSecurityFixturesFromHandle } from '../testing/security-fixtures.js';
import { staffPropertyAssignments } from '../db/schema.js';
import { AuditValidationError } from '../audit/metadata.js';

const skipReason = getSecurityIntegrationSkipReason();

if (skipReason) {
	test('assignments audit rollback', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('appendAudit failure rolls back staff property assignment insert', async () => {
		mock.module('../audit/append.js', {
			namedExports: {
				appendAudit: async () => {
					throw new AuditValidationError('INVALID_ACTION', 'forced audit failure');
				}
			}
		});

		const { assignStaffProperty } = await import('./assignments.js');

		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			const staffId = fixture.ids.staffAEmpty.staffProfileId;
			const propertyId = fixture.ids.propertyA2.propertyId;

			await assert.rejects(
				() =>
					assignStaffProperty(
						handle.db,
						{
							kind: 'USER',
							userId: fixture.ids.landlordA.userId,
							role: 'LANDLORD',
							landlordId: fixture.ids.landlordA.landlordProfileId
						},
						{ staffId, propertyId }
					),
				AuditValidationError
			);

			const active = await handle.db.query.staffPropertyAssignments.findMany({
				where: and(
					eq(staffPropertyAssignments.staffId, staffId),
					eq(staffPropertyAssignments.propertyId, propertyId),
					isNull(staffPropertyAssignments.revokedAt)
				)
			});
			assert.equal(active.length, 0);
		});

		mock.restoreAll();
	});
}
