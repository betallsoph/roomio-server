import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import {
	SECURITY_FIXTURE_KNOWN_GAPS,
	encodeTestSessionCookie,
	fixtureSession,
	formatSecurityFixtureMap,
	seedSecurityFixturesFromHandle,
	type SecurityFixtureMap
} from './security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	isSecurityIntegrationEnabled,
	withSecurityDb
} from './test-db.js';
import { rooms, users } from '../db/schema.js';

function mockFixture(): SecurityFixtureMap {
	const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
	return {
		runId: 'sec_mock_run',
		ids: {
			superAdmin: { userId: id('01') },
			landlordA: { userId: id('02'), landlordProfileId: id('03') },
			landlordB: { userId: id('04'), landlordProfileId: id('05') },
			tenantAOld: { userId: id('06'), tenantProfileId: id('07') },
			tenantANow: { userId: id('08'), tenantProfileId: id('09') },
			tenantA2Now: { userId: id('10'), tenantProfileId: id('11') },
			tenantBNow: { userId: id('12'), tenantProfileId: id('13') },
			staffALimited: {
				userId: id('14'),
				staffProfileId: id('15'),
				staffLandlordId: id('03')
			},
			staffAEmpty: {
				userId: id('16'),
				staffProfileId: id('17'),
				staffLandlordId: id('03')
			},
			staffB: {
				userId: id('18'),
				staffProfileId: id('19'),
				staffLandlordId: id('05')
			},
			propertyA1: { propertyId: id('20') },
			propertyA2: { propertyId: id('21') },
			propertyB1: { propertyId: id('22') },
			roomA1R1: { roomId: id('23') },
			roomA2R1: { roomId: id('24') },
			roomB1R1: { roomId: id('25') },
			serviceA: { serviceId: id('26') },
			serviceB: { serviceId: id('27') },
			paymentAccountA: { paymentAccountId: id('28') },
			paymentAccountB: { paymentAccountId: id('29') },
			contractAOld: { contractId: id('30') },
			contractANow: { contractId: id('31') },
			contractA2Now: { contractId: id('32') },
			contractBNow: { contractId: id('33') },
			invoiceAOld: { invoiceId: id('34') },
			invoiceANow: { invoiceId: id('35') },
			invoiceA2Now: { invoiceId: id('36') },
			invoiceBNow: { invoiceId: id('37') },
			meterReadingAOld: { meterReadingId: id('38') },
			meterReadingANow: { meterReadingId: id('39') },
			meterReadingBNow: { meterReadingId: id('40') },
			maintenanceAOld: { maintenanceRequestId: id('41') },
			maintenanceANow: { maintenanceRequestId: id('42') },
			expenseA: { expenseId: id('43') },
			expenseB: { expenseId: id('44') },
			supportContactA: { supportContactId: id('45') },
			supportContactB: { supportContactId: id('46') }
		}
	};
}

test('SECURITY_FIXTURE_KNOWN_GAPS documents AUTH-004 and AUTH-008 deferrals', () => {
	assert.ok(SECURITY_FIXTURE_KNOWN_GAPS.length >= 3);
	assert.ok(
		SECURITY_FIXTURE_KNOWN_GAPS.some(
			(gap) => gap.includes('AUTH-004') && gap.includes('ManagedTenant')
		)
	);
	assert.ok(
		SECURITY_FIXTURE_KNOWN_GAPS.some((gap) => gap.includes('AUTH-008') && gap.includes('endpoint'))
	);
	assert.ok(
		!SECURITY_FIXTURE_KNOWN_GAPS.some(
			(gap) => gap.includes('AUTH-005') && gap.includes('not in schema')
		)
	);
});

test('fixtureSession maps named actors to SessionData', () => {
	const fixture = mockFixture();

	assert.deepEqual(fixtureSession(fixture, 'landlordA'), {
		userId: fixture.ids.landlordA.userId,
		role: 'LANDLORD',
		landlordProfileId: fixture.ids.landlordA.landlordProfileId,
		enabledRentalTypes: null,
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null
	});

	assert.deepEqual(fixtureSession(fixture, 'tenantANow'), {
		userId: fixture.ids.tenantANow.userId,
		role: 'TENANT',
		landlordProfileId: null,
		enabledRentalTypes: null,
		tenantProfileId: fixture.ids.tenantANow.tenantProfileId,
		staffProfileId: null,
		staffLandlordId: null
	});

	assert.deepEqual(fixtureSession(fixture, 'staffALimited'), {
		userId: fixture.ids.staffALimited.userId,
		role: 'STAFF',
		landlordProfileId: null,
		enabledRentalTypes: null,
		tenantProfileId: null,
		staffProfileId: fixture.ids.staffALimited.staffProfileId,
		staffLandlordId: fixture.ids.landlordA.landlordProfileId
	});
});

test('encodeTestSessionCookie produces payload.signature format', () => {
	const secret = 'test-session-secret-32-chars-min!!';
	const cookie = encodeTestSessionCookie(fixtureSession(mockFixture(), 'landlordB'), secret);
	const [payload, signature] = cookie.split('.');
	assert.ok(payload);
	assert.ok(signature);
	assert.match(payload, /^[A-Za-z0-9_-]+$/);
});

test('formatSecurityFixtureMap includes runId and named keys', () => {
	const text = formatSecurityFixtureMap(mockFixture());
	assert.match(text, /runId=sec_mock_run/);
	assert.match(text, /landlordA:/);
	assert.match(text, /tenantAOld:/);
	assert.match(text, /staffALimited:/);
});

const integrationSkip = getSecurityIntegrationSkipReason();

if (!integrationSkip) {
	test.after(async () => {
		await closeSecurityDbPool();
	});
}

test(
	'seedSecurityFixtures seeds landlord A/B topology with legacy room tenant',
	{ skip: integrationSkip },
	async () => {
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);

			const [roomA1] = await handle.db
				.select({ tenantId: rooms.tenantId })
				.from(rooms)
				.where(eq(rooms.id, fixture.ids.roomA1R1.roomId));
			assert.equal(roomA1?.tenantId, fixture.ids.tenantANow.tenantProfileId);

			const actorCount = await handle.db.select({ id: users.id }).from(users);
			assert.equal(actorCount.length, 10);

			assert.notEqual(
				fixture.ids.landlordA.landlordProfileId,
				fixture.ids.landlordB.landlordProfileId
			);
			assert.notEqual(fixture.ids.invoiceAOld.invoiceId, fixture.ids.invoiceANow.invoiceId);
			assert.notEqual(
				fixture.ids.meterReadingAOld.meterReadingId,
				fixture.ids.meterReadingANow.meterReadingId
			);
		});
	}
);

test(
	'seedSecurityFixtures can run twice without unique-key collisions',
	{ skip: integrationSkip },
	async () => {
		if (!isSecurityIntegrationEnabled()) return;

		await withSecurityDb(async (handle) => {
			await seedSecurityFixturesFromHandle(handle);
		});
		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			assert.ok(fixture.runId.startsWith('sec_'));
		});
	}
);
