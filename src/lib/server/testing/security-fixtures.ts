import crypto from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SessionData } from '../session.js';
import {
	users,
	landlordProfiles,
	tenantProfiles,
	staffProfiles,
	staffPropertyAssignments,
	staffPermissions,
	paymentAccounts,
	properties,
	rooms,
	services,
	contracts,
	invoices,
	invoiceItems,
	meterReadings,
	maintenanceRequests,
	expenses,
	supportContacts
} from '../db/schema.js';
import type * as schema from '../db/schema.js';
import type { SecurityDbHandle } from './test-db.js';

/**
 * Gaps between this harness and production-hardening §12.1 / later AUTH tickets.
 * Downstream security tests must not assume these exist until the linked ticket lands.
 */
export const SECURITY_FIXTURE_KNOWN_GAPS = [
	'AUTH-004: ManagedTenant/Tenancy tables and full §12.1 tenancy topology are not seeded; tenant history uses TenantProfile + Room.tenantId legacy pattern only.',
	'AUTH-004: U-shared multi-claim ManagedTenant scenario is not represented; tenantANow and tenantA2Now are separate users.',
	'AUTH-004: Tenancy-scoped invoice/contract ownership is approximated via tenantId/roomId snapshots; legacy invoices without tenancy mapping remain landlord-only by characterization.',
	'AUTH-008: List/detail endpoint SQL scoping (rooms, meters, tenants, requests) is not fully enforced in this harness; staff fixture grants do not imply cross-endpoint access until AUTH-008 lands.'
] as const;

export type SecurityFixtureActor =
	| 'superAdmin'
	| 'landlordA'
	| 'landlordB'
	| 'tenantAOld'
	| 'tenantANow'
	| 'tenantA2Now'
	| 'tenantBNow'
	| 'staffALimited'
	| 'staffAEmpty'
	| 'staffB';

export type SecurityFixtureIds = {
	superAdmin: { userId: string };
	landlordA: { userId: string; landlordProfileId: string };
	landlordB: { userId: string; landlordProfileId: string };
	tenantAOld: { userId: string; tenantProfileId: string };
	tenantANow: { userId: string; tenantProfileId: string };
	tenantA2Now: { userId: string; tenantProfileId: string };
	tenantBNow: { userId: string; tenantProfileId: string };
	staffALimited: { userId: string; staffProfileId: string; staffLandlordId: string };
	staffAEmpty: { userId: string; staffProfileId: string; staffLandlordId: string };
	staffB: { userId: string; staffProfileId: string; staffLandlordId: string };
	propertyA1: { propertyId: string };
	propertyA2: { propertyId: string };
	propertyB1: { propertyId: string };
	roomA1R1: { roomId: string };
	roomA2R1: { roomId: string };
	roomB1R1: { roomId: string };
	serviceA: { serviceId: string };
	serviceB: { serviceId: string };
	paymentAccountA: { paymentAccountId: string };
	paymentAccountB: { paymentAccountId: string };
	contractAOld: { contractId: string };
	contractANow: { contractId: string };
	contractA2Now: { contractId: string };
	contractBNow: { contractId: string };
	invoiceAOld: { invoiceId: string };
	invoiceANow: { invoiceId: string };
	invoiceA2Now: { invoiceId: string };
	invoiceBNow: { invoiceId: string };
	meterReadingAOld: { meterReadingId: string };
	meterReadingANow: { meterReadingId: string };
	meterReadingBNow: { meterReadingId: string };
	maintenanceAOld: { maintenanceRequestId: string };
	maintenanceANow: { maintenanceRequestId: string };
	expenseA: { expenseId: string };
	expenseB: { expenseId: string };
	supportContactA: { supportContactId: string };
	supportContactB: { supportContactId: string };
};

export type SecurityFixtureMap = {
	runId: string;
	ids: SecurityFixtureIds;
};

function uuid(): string {
	return crypto.randomUUID();
}

function userRow(id: string, email: string, phone: string, name: string, role: string) {
	return {
		id,
		email,
		phone,
		passwordHash: 'security-fixture-test-hash',
		name,
		role,
		isActive: true
	};
}

/**
 * Seed the Landlord A/B security topology adapted to the current schema.
 * Caller should run inside `withSecurityDb` or after `resetSecurityDb`.
 */
export async function seedSecurityFixtures(
	db: NodePgDatabase<typeof schema>,
	runId: string
): Promise<SecurityFixtureMap> {
	const ids: SecurityFixtureIds = {
		superAdmin: { userId: uuid() },
		landlordA: { userId: uuid(), landlordProfileId: uuid() },
		landlordB: { userId: uuid(), landlordProfileId: uuid() },
		tenantAOld: { userId: uuid(), tenantProfileId: uuid() },
		tenantANow: { userId: uuid(), tenantProfileId: uuid() },
		tenantA2Now: { userId: uuid(), tenantProfileId: uuid() },
		tenantBNow: { userId: uuid(), tenantProfileId: uuid() },
		staffALimited: {
			userId: uuid(),
			staffProfileId: uuid(),
			staffLandlordId: '' // filled after landlordA id is known
		},
		staffAEmpty: {
			userId: uuid(),
			staffProfileId: uuid(),
			staffLandlordId: ''
		},
		staffB: {
			userId: uuid(),
			staffProfileId: uuid(),
			staffLandlordId: ''
		},
		propertyA1: { propertyId: uuid() },
		propertyA2: { propertyId: uuid() },
		propertyB1: { propertyId: uuid() },
		roomA1R1: { roomId: uuid() },
		roomA2R1: { roomId: uuid() },
		roomB1R1: { roomId: uuid() },
		serviceA: { serviceId: uuid() },
		serviceB: { serviceId: uuid() },
		paymentAccountA: { paymentAccountId: uuid() },
		paymentAccountB: { paymentAccountId: uuid() },
		contractAOld: { contractId: uuid() },
		contractANow: { contractId: uuid() },
		contractA2Now: { contractId: uuid() },
		contractBNow: { contractId: uuid() },
		invoiceAOld: { invoiceId: uuid() },
		invoiceANow: { invoiceId: uuid() },
		invoiceA2Now: { invoiceId: uuid() },
		invoiceBNow: { invoiceId: uuid() },
		meterReadingAOld: { meterReadingId: uuid() },
		meterReadingANow: { meterReadingId: uuid() },
		meterReadingBNow: { meterReadingId: uuid() },
		maintenanceAOld: { maintenanceRequestId: uuid() },
		maintenanceANow: { maintenanceRequestId: uuid() },
		expenseA: { expenseId: uuid() },
		expenseB: { expenseId: uuid() },
		supportContactA: { supportContactId: uuid() },
		supportContactB: { supportContactId: uuid() }
	};

	ids.staffALimited.staffLandlordId = ids.landlordA.landlordProfileId;
	ids.staffAEmpty.staffLandlordId = ids.landlordA.landlordProfileId;
	ids.staffB.staffLandlordId = ids.landlordB.landlordProfileId;

	const tag = runId.slice(-8);

	await db
		.insert(users)
		.values([
			userRow(
				ids.superAdmin.userId,
				`sec-sa-${tag}@fixture.test`,
				`0900${tag}01`,
				'Super Admin',
				'SUPER_ADMIN'
			),
			userRow(
				ids.landlordA.userId,
				`sec-la-${tag}@fixture.test`,
				`0900${tag}02`,
				'Landlord A',
				'LANDLORD'
			),
			userRow(
				ids.landlordB.userId,
				`sec-lb-${tag}@fixture.test`,
				`0900${tag}03`,
				'Landlord B',
				'LANDLORD'
			),
			userRow(
				ids.tenantAOld.userId,
				`sec-ta-old-${tag}@fixture.test`,
				`0900${tag}04`,
				'Tenant A Old',
				'TENANT'
			),
			userRow(
				ids.tenantANow.userId,
				`sec-ta-now-${tag}@fixture.test`,
				`0900${tag}05`,
				'Tenant A Now',
				'TENANT'
			),
			userRow(
				ids.tenantA2Now.userId,
				`sec-ta2-now-${tag}@fixture.test`,
				`0900${tag}06`,
				'Tenant A2 Now',
				'TENANT'
			),
			userRow(
				ids.tenantBNow.userId,
				`sec-tb-now-${tag}@fixture.test`,
				`0900${tag}07`,
				'Tenant B Now',
				'TENANT'
			),
			userRow(
				ids.staffALimited.userId,
				`sec-staff-a-lim-${tag}@fixture.test`,
				`0900${tag}08`,
				'Staff A Limited',
				'STAFF'
			),
			userRow(
				ids.staffAEmpty.userId,
				`sec-staff-a-empty-${tag}@fixture.test`,
				`0900${tag}09`,
				'Staff A Empty',
				'STAFF'
			),
			userRow(
				ids.staffB.userId,
				`sec-staff-b-${tag}@fixture.test`,
				`0900${tag}10`,
				'Staff B',
				'STAFF'
			)
		]);

	await db.insert(landlordProfiles).values([
		{ id: ids.landlordA.landlordProfileId, userId: ids.landlordA.userId },
		{ id: ids.landlordB.landlordProfileId, userId: ids.landlordB.userId }
	]);

	await db.insert(tenantProfiles).values([
		{
			id: ids.tenantAOld.tenantProfileId,
			userId: ids.tenantAOld.userId,
			idNumber: `OLD-${tag}`,
			moveInDate: '2025-01-01',
			deposit: 1_000_000,
			notes: 'Former occupant of room A1-R1 (legacy characterization)'
		},
		{
			id: ids.tenantANow.tenantProfileId,
			userId: ids.tenantANow.userId,
			idNumber: `NOW-${tag}`,
			moveInDate: '2026-01-01',
			deposit: 2_000_000,
			notes: 'Current occupant of room A1-R1'
		},
		{
			id: ids.tenantA2Now.tenantProfileId,
			userId: ids.tenantA2Now.userId,
			idNumber: `A2-${tag}`,
			moveInDate: '2026-02-01',
			deposit: 1_500_000
		},
		{
			id: ids.tenantBNow.tenantProfileId,
			userId: ids.tenantBNow.userId,
			idNumber: `B-${tag}`,
			moveInDate: '2026-03-01',
			deposit: 800_000
			// telegramUserId omitted — unclaimed contact snapshot analogue until AUTH-004
		}
	]);

	await db.insert(staffProfiles).values([
		{
			id: ids.staffALimited.staffProfileId,
			userId: ids.staffALimited.userId,
			landlordId: ids.landlordA.landlordProfileId
		},
		{
			id: ids.staffAEmpty.staffProfileId,
			userId: ids.staffAEmpty.userId,
			landlordId: ids.landlordA.landlordProfileId
		},
		{
			id: ids.staffB.staffProfileId,
			userId: ids.staffB.userId,
			landlordId: ids.landlordB.landlordProfileId
		}
	]);

	await db.insert(staffPropertyAssignments).values({
		staffId: ids.staffALimited.staffProfileId,
		propertyId: ids.propertyA1.propertyId,
		assignedByUserId: ids.landlordA.userId
	});

	await db.insert(staffPermissions).values([
		{
			staffId: ids.staffALimited.staffProfileId,
			permission: 'VIEW_ROOMS',
			grantedByUserId: ids.landlordA.userId
		},
		{
			staffId: ids.staffALimited.staffProfileId,
			permission: 'MANAGE_METERS',
			grantedByUserId: ids.landlordA.userId
		}
	]);

	await db.insert(paymentAccounts).values([
		{
			id: ids.paymentAccountA.paymentAccountId,
			landlordId: ids.landlordA.landlordProfileId,
			name: 'Landlord A VietQR',
			provider: 'vietqr',
			isDefault: true,
			accountNumber: `A-${tag}`,
			accountName: 'Landlord A'
		},
		{
			id: ids.paymentAccountB.paymentAccountId,
			landlordId: ids.landlordB.landlordProfileId,
			name: 'Landlord B VietQR',
			provider: 'vietqr',
			isDefault: true,
			accountNumber: `B-${tag}`,
			accountName: 'Landlord B'
		}
	]);

	await db.insert(properties).values([
		{
			id: ids.propertyA1.propertyId,
			landlordId: ids.landlordA.landlordProfileId,
			name: 'Property A1',
			shortName: 'A1',
			address: 'Fixture address A1'
		},
		{
			id: ids.propertyA2.propertyId,
			landlordId: ids.landlordA.landlordProfileId,
			name: 'Property A2',
			shortName: 'A2',
			address: 'Fixture address A2'
		},
		{
			id: ids.propertyB1.propertyId,
			landlordId: ids.landlordB.landlordProfileId,
			name: 'Property B1',
			shortName: 'B1',
			address: 'Fixture address B1'
		}
	]);

	await db.insert(rooms).values([
		{
			id: ids.roomA1R1.roomId,
			propertyId: ids.propertyA1.propertyId,
			roomNumber: 'A1-R1',
			roomType: 'standard',
			status: 'paid',
			monthlyRent: 3_500_000,
			tenantId: ids.tenantANow.tenantProfileId,
			paymentAccountId: ids.paymentAccountA.paymentAccountId
		},
		{
			id: ids.roomA2R1.roomId,
			propertyId: ids.propertyA2.propertyId,
			roomNumber: 'A2-R1',
			roomType: 'standard',
			status: 'paid',
			monthlyRent: 4_000_000,
			tenantId: ids.tenantA2Now.tenantProfileId,
			paymentAccountId: ids.paymentAccountA.paymentAccountId
		},
		{
			id: ids.roomB1R1.roomId,
			propertyId: ids.propertyB1.propertyId,
			roomNumber: 'B1-R1',
			roomType: 'standard',
			status: 'paid',
			monthlyRent: 2_800_000,
			tenantId: ids.tenantBNow.tenantProfileId,
			paymentAccountId: ids.paymentAccountB.paymentAccountId
		}
	]);

	await db.insert(services).values([
		{
			id: ids.serviceA.serviceId,
			landlordId: ids.landlordA.landlordProfileId,
			name: 'Điện',
			type: 'METERED',
			defaultRate: 3_500
		},
		{
			id: ids.serviceB.serviceId,
			landlordId: ids.landlordB.landlordProfileId,
			name: 'Điện',
			type: 'METERED',
			defaultRate: 3_200
		}
	]);

	await db.insert(contracts).values([
		{
			id: ids.contractAOld.contractId,
			tenantId: ids.tenantAOld.tenantProfileId,
			roomId: ids.roomA1R1.roomId,
			startDate: '2025-01-01',
			endDate: '2025-12-31',
			monthlyRent: 3_200_000,
			deposit: 1_000_000,
			status: 'terminated',
			paymentAccountId: ids.paymentAccountA.paymentAccountId
		},
		{
			id: ids.contractANow.contractId,
			tenantId: ids.tenantANow.tenantProfileId,
			roomId: ids.roomA1R1.roomId,
			startDate: '2026-01-01',
			endDate: '2026-12-31',
			monthlyRent: 3_500_000,
			deposit: 2_000_000,
			status: 'active',
			paymentAccountId: ids.paymentAccountA.paymentAccountId
		},
		{
			id: ids.contractA2Now.contractId,
			tenantId: ids.tenantA2Now.tenantProfileId,
			roomId: ids.roomA2R1.roomId,
			startDate: '2026-02-01',
			endDate: '2027-01-31',
			monthlyRent: 4_000_000,
			deposit: 1_500_000,
			status: 'active',
			paymentAccountId: ids.paymentAccountA.paymentAccountId
		},
		{
			id: ids.contractBNow.contractId,
			tenantId: ids.tenantBNow.tenantProfileId,
			roomId: ids.roomB1R1.roomId,
			startDate: '2026-03-01',
			endDate: '2027-02-28',
			monthlyRent: 2_800_000,
			deposit: 800_000,
			status: 'active',
			paymentAccountId: ids.paymentAccountB.paymentAccountId
		}
	]);

	await db.insert(invoices).values([
		{
			id: ids.invoiceAOld.invoiceId,
			roomId: ids.roomA1R1.roomId,
			roomNumber: 'A1-R1',
			tenantName: 'Tenant A Old',
			tenantPhone: `0900${tag}04`,
			month: '2025-12',
			rentAmount: 3_200_000,
			totalAmount: 3_450_000,
			dueDate: '2025-12-10',
			paidDate: '2025-12-09',
			status: 'paid',
			paymentAccountId: ids.paymentAccountA.paymentAccountId,
			createdAt: '2025-12-01',
			notes: 'Legacy invoice for former tenant on same room'
		},
		{
			id: ids.invoiceANow.invoiceId,
			roomId: ids.roomA1R1.roomId,
			roomNumber: 'A1-R1',
			tenantName: 'Tenant A Now',
			tenantPhone: `0900${tag}05`,
			month: '2026-06',
			rentAmount: 3_500_000,
			totalAmount: 3_820_000,
			dueDate: '2026-06-10',
			status: 'pending',
			paymentAccountId: ids.paymentAccountA.paymentAccountId,
			createdAt: '2026-06-01'
		},
		{
			id: ids.invoiceA2Now.invoiceId,
			roomId: ids.roomA2R1.roomId,
			roomNumber: 'A2-R1',
			tenantName: 'Tenant A2 Now',
			tenantPhone: `0900${tag}06`,
			month: '2026-06',
			rentAmount: 4_000_000,
			totalAmount: 4_200_000,
			dueDate: '2026-06-10',
			status: 'pending',
			paymentAccountId: ids.paymentAccountA.paymentAccountId,
			createdAt: '2026-06-01'
		},
		{
			id: ids.invoiceBNow.invoiceId,
			roomId: ids.roomB1R1.roomId,
			roomNumber: 'B1-R1',
			tenantName: 'Tenant B Now',
			tenantPhone: `0900${tag}07`,
			month: '2026-06',
			rentAmount: 2_800_000,
			totalAmount: 3_000_000,
			dueDate: '2026-06-10',
			status: 'pending',
			paymentAccountId: ids.paymentAccountB.paymentAccountId,
			createdAt: '2026-06-01'
		}
	]);

	await db.insert(invoiceItems).values([
		{
			id: uuid(),
			invoiceId: ids.invoiceAOld.invoiceId,
			name: 'Tiền phòng',
			amount: 3_200_000
		},
		{
			id: uuid(),
			invoiceId: ids.invoiceANow.invoiceId,
			name: 'Tiền phòng',
			amount: 3_500_000
		}
	]);

	await db.insert(meterReadings).values([
		{
			id: ids.meterReadingAOld.meterReadingId,
			roomId: ids.roomA1R1.roomId,
			serviceId: ids.serviceA.serviceId,
			month: '2025-11',
			prevValue: 0,
			currValue: 120,
			recordedAt: '2025-11-30',
			status: 'approved',
			submittedBy: 'LANDLORD'
		},
		{
			id: ids.meterReadingANow.meterReadingId,
			roomId: ids.roomA1R1.roomId,
			serviceId: ids.serviceA.serviceId,
			month: '2026-06',
			prevValue: 120,
			currValue: 185,
			recordedAt: '2026-06-30',
			status: 'pending',
			submittedBy: 'TENANT',
			photoUrl: 'fixture-meter-a-now.jpg'
		},
		{
			id: ids.meterReadingBNow.meterReadingId,
			roomId: ids.roomB1R1.roomId,
			serviceId: ids.serviceB.serviceId,
			month: '2026-06',
			prevValue: 0,
			currValue: 95,
			recordedAt: '2026-06-30',
			status: 'approved',
			submittedBy: 'LANDLORD'
		}
	]);

	await db.insert(maintenanceRequests).values([
		{
			id: ids.maintenanceAOld.maintenanceRequestId,
			tenantId: ids.tenantAOld.tenantProfileId,
			roomNumber: 'A1-R1',
			buildingName: 'Property A1',
			category: 'plumbing',
			title: 'Old tenant leak',
			description: 'Fixture request from former tenant',
			status: 'completed',
			priority: 'normal'
		},
		{
			id: ids.maintenanceANow.maintenanceRequestId,
			tenantId: ids.tenantANow.tenantProfileId,
			roomNumber: 'A1-R1',
			buildingName: 'Property A1',
			category: 'electrical',
			title: 'Current tenant outlet',
			description: 'Fixture request from current tenant',
			status: 'pending',
			priority: 'important'
		}
	]);

	await db.insert(expenses).values([
		{
			id: ids.expenseA.expenseId,
			landlordId: ids.landlordA.landlordProfileId,
			propertyId: ids.propertyA1.propertyId,
			category: 'maintenance',
			description: 'Landlord A expense',
			amount: 500_000,
			date: '2026-06-15'
		},
		{
			id: ids.expenseB.expenseId,
			landlordId: ids.landlordB.landlordProfileId,
			propertyId: ids.propertyB1.propertyId,
			category: 'cleaning',
			description: 'Landlord B expense',
			amount: 300_000,
			date: '2026-06-15'
		}
	]);

	await db.insert(supportContacts).values([
		{
			id: ids.supportContactA.supportContactId,
			landlordId: ids.landlordA.landlordProfileId,
			category: 'repair',
			name: 'A Repair Co',
			phone: `0900${tag}91`
		},
		{
			id: ids.supportContactB.supportContactId,
			landlordId: ids.landlordB.landlordProfileId,
			category: 'repair',
			name: 'B Repair Co',
			phone: `0900${tag}92`
		}
	]);

	return { runId, ids };
}

/** Convenience wrapper using the shared security DB handle. */
export async function seedSecurityFixturesFromHandle(
	handle: SecurityDbHandle
): Promise<SecurityFixtureMap> {
	return seedSecurityFixtures(handle.db, handle.runId);
}

const EMPTY_SESSION_FIELDS = {
	landlordProfileId: null,
	enabledRentalTypes: null,
	tenantProfileId: null,
	staffProfileId: null,
	staffLandlordId: null
} as const;

/** Build SessionData for a named fixture actor (for handler tests via event.locals.session). */
export function fixtureSession(
	fixture: SecurityFixtureMap,
	actor: SecurityFixtureActor
): SessionData {
	switch (actor) {
		case 'superAdmin':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.superAdmin.userId,
				role: 'SUPER_ADMIN'
			};
		case 'landlordA':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.landlordA.userId,
				role: 'LANDLORD',
				landlordProfileId: fixture.ids.landlordA.landlordProfileId
			};
		case 'landlordB':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.landlordB.userId,
				role: 'LANDLORD',
				landlordProfileId: fixture.ids.landlordB.landlordProfileId
			};
		case 'tenantAOld':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.tenantAOld.userId,
				role: 'TENANT',
				tenantProfileId: fixture.ids.tenantAOld.tenantProfileId
			};
		case 'tenantANow':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.tenantANow.userId,
				role: 'TENANT',
				tenantProfileId: fixture.ids.tenantANow.tenantProfileId
			};
		case 'tenantA2Now':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.tenantA2Now.userId,
				role: 'TENANT',
				tenantProfileId: fixture.ids.tenantA2Now.tenantProfileId
			};
		case 'tenantBNow':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.tenantBNow.userId,
				role: 'TENANT',
				tenantProfileId: fixture.ids.tenantBNow.tenantProfileId
			};
		case 'staffALimited':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.staffALimited.userId,
				role: 'STAFF',
				staffProfileId: fixture.ids.staffALimited.staffProfileId,
				staffLandlordId: fixture.ids.staffALimited.staffLandlordId
			};
		case 'staffAEmpty':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.staffAEmpty.userId,
				role: 'STAFF',
				staffProfileId: fixture.ids.staffAEmpty.staffProfileId,
				staffLandlordId: fixture.ids.staffAEmpty.staffLandlordId
			};
		case 'staffB':
			return {
				...EMPTY_SESSION_FIELDS,
				userId: fixture.ids.staffB.userId,
				role: 'STAFF',
				staffProfileId: fixture.ids.staffB.staffProfileId,
				staffLandlordId: fixture.ids.staffB.staffLandlordId
			};
		default: {
			const _exhaustive: never = actor;
			throw new Error(`Unknown fixture actor: ${_exhaustive}`);
		}
	}
}

/** Encode a signed session cookie value for HTTP-level handler tests. */
export function encodeTestSessionCookie(data: SessionData, secret: string): string {
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
	return `${payload}.${signature}`;
}

/** Human-readable fixture map for debugging failed security tests. */
export function formatSecurityFixtureMap(fixture: SecurityFixtureMap): string {
	const lines = Object.entries(fixture.ids).map(([name, value]) => {
		const parts = Object.entries(value as Record<string, string>)
			.map(([k, v]) => `${k}=${v}`)
			.join(', ');
		return `  ${name}: { ${parts} }`;
	});
	return [`runId=${fixture.runId}`, ...lines].join('\n');
}
