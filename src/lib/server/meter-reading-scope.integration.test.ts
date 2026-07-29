import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type {
	LandlordActor,
	StaffActor,
	SuperAdminActor,
	TenantActor
} from './authorization/actor.js';
import { createDrizzleActorDb, getUserActor } from './authorization/load-user-actor.js';
import type { SessionData } from './session.js';

// AUTH-013 PostgreSQL integration test cho GET/POST/PUT /api/meter-readings.
//
// An toàn: CHỈ chạy khi DATABASE_URL trỏ tới Postgres localhost có tên DB đánh dấu test
// (auth013/test/disposable). Nếu không, test tự skip với lý do BLOCKED_INTEGRATION_TEST.

const DB_URL = process.env.DATABASE_URL ?? '';

function isDisposableTestDb(raw: string): boolean {
	try {
		const u = new URL(raw);
		const localish = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
		const dbName = u.pathname.replace(/^\//, '');
		return localish && /auth013|test|disposable/i.test(dbName);
	} catch {
		return false;
	}
}

const RUN = DB_URL.startsWith('postgres') && isDisposableTestDb(DB_URL);

const U_LA: string = 'a13-u-la';
const U_LB: string = 'a13-u-lb';
const U_TC: string = 'a13-u-tc';
const U_SA: string = 'a13-u-sa';
const LA: string = 'a13-la';
const LB: string = 'a13-lb';
const TC: string = 'a13-tc';
const SP_A: string = 'a13-sp-a';
const PA: string = 'a13-pa';
const PB: string = 'a13-pb';
const RA: string = 'a13-ra';
const RB: string = 'a13-rb';
const SA: string = 'a13-sa';
const SB: string = 'a13-sb';

function landlordSession(): SessionData {
	return {
		userId: U_LA,
		role: 'LANDLORD',
		landlordProfileId: LA,
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null
	};
}

function tenantSession(): SessionData {
	return {
		userId: U_TC,
		role: 'TENANT',
		landlordProfileId: null,
		tenantProfileId: TC,
		staffProfileId: null,
		staffLandlordId: null
	};
}

function staffSession(): SessionData {
	return {
		userId: U_SA,
		role: 'STAFF',
		landlordProfileId: null,
		tenantProfileId: null,
		staffProfileId: SP_A,
		staffLandlordId: LA
	};
}

function superAdminActor(): SuperAdminActor {
	return { kind: 'USER', userId: 'a13-super-admin', role: 'SUPER_ADMIN' };
}

if (!RUN) {
	test(
		'meter-readings GET A/B integration',
		{
			skip: 'BLOCKED_INTEGRATION_TEST: set DATABASE_URL to a disposable localhost *test* Postgres'
		},
		() => {}
	);
} else {
	const { GET, POST, PUT } = await import('../../routes/api/meter-readings/+server.js');
	const { db } = await import('./db/index.js');
	const {
		users,
		landlordProfiles,
		tenantProfiles,
		staffProfiles,
		properties,
		rooms,
		services,
		meterReadings
	} = await import('./db/schema.js');
	const { inArray } = await import('drizzle-orm');

	let landlordActor: LandlordActor;
	let tenantActor: TenantActor;
	let staffActor: StaffActor;

	async function cleanup() {
		await db.delete(users).where(inArray(users.id, [U_LA, U_LB, U_TC, U_SA]));
	}

	async function call(handler: unknown, event: Record<string, unknown>): Promise<Response> {
		return (handler as (e: unknown) => Promise<Response>)(event);
	}

	async function getReadings(actor: App.Locals['actor'], params: Record<string, string> = {}) {
		const qs = new URLSearchParams(params).toString();
		const url = new URL(`http://localhost/api/meter-readings${qs ? '?' + qs : ''}`);
		const res = await call(GET, { url, locals: { actor } });
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			body = null;
		}
		return { status: res.status, body };
	}

	const roomIdsOf = (body: unknown): string[] =>
		Array.isArray(body) ? body.map((r) => (r as { roomId: string }).roomId) : [];

	before(async () => {
		await cleanup();
		await db.insert(users).values([
			{
				id: U_LA,
				email: 'a13-la@test.local',
				phone: 'a13-000001',
				passwordHash: 'x',
				name: 'LA',
				role: 'LANDLORD',
				isActive: true
			},
			{
				id: U_LB,
				email: 'a13-lb@test.local',
				phone: 'a13-000002',
				passwordHash: 'x',
				name: 'LB',
				role: 'LANDLORD',
				isActive: true
			},
			{
				id: U_TC,
				email: 'a13-tc@test.local',
				phone: 'a13-000003',
				passwordHash: 'x',
				name: 'TC',
				role: 'TENANT',
				isActive: true
			},
			{
				id: U_SA,
				email: 'a13-sa@test.local',
				phone: 'a13-000004',
				passwordHash: 'x',
				name: 'SA',
				role: 'STAFF',
				isActive: true
			}
		]);
		await db.insert(landlordProfiles).values([
			{ id: LA, userId: U_LA },
			{ id: LB, userId: U_LB }
		]);
		await db
			.insert(tenantProfiles)
			.values([{ id: TC, userId: U_TC, idNumber: 'A13-ID', moveInDate: '2026-01-01', deposit: 0 }]);
		await db.insert(staffProfiles).values({
			id: SP_A,
			userId: U_SA,
			landlordId: LA
		});
		await db.insert(properties).values([
			{ id: PA, landlordId: LA, name: 'Prop A', shortName: 'A', address: 'addr A' },
			{ id: PB, landlordId: LB, name: 'Prop B', shortName: 'B', address: 'addr B' }
		]);
		await db.insert(rooms).values([
			{
				id: RA,
				propertyId: PA,
				roomNumber: 'A-101',
				roomType: 'standard',
				status: 'paid',
				monthlyRent: 1,
				tenantId: TC
			},
			{
				id: RB,
				propertyId: PB,
				roomNumber: 'B-101',
				roomType: 'standard',
				status: 'paid',
				monthlyRent: 1
			}
		]);
		await db.insert(services).values([
			{ id: SA, landlordId: LA, name: 'Điện', type: 'METERED', defaultRate: 3000 },
			{ id: SB, landlordId: LB, name: 'Điện', type: 'METERED', defaultRate: 3000 }
		]);
		await db.insert(meterReadings).values([
			{
				id: 'a13-mr-a-old',
				roomId: RA,
				serviceId: SA,
				month: '2026-05',
				prevValue: 0,
				currValue: 100,
				recordedAt: '2026-05-31',
				status: 'approved',
				submittedBy: 'LANDLORD'
			},
			{
				id: 'a13-mr-a-cur',
				roomId: RA,
				serviceId: SA,
				month: '2026-06',
				prevValue: 100,
				currValue: 150,
				recordedAt: '2026-06-30',
				status: 'pending',
				submittedBy: 'TENANT',
				photoUrl: 'x.jpg'
			},
			{
				id: 'a13-mr-b',
				roomId: RB,
				serviceId: SB,
				month: '2026-06',
				prevValue: 0,
				currValue: 80,
				recordedAt: '2026-06-30',
				status: 'approved',
				submittedBy: 'LANDLORD'
			}
		]);

		const actorDb = createDrizzleActorDb(db);
		landlordActor = (await getUserActor(landlordSession(), actorDb)) as LandlordActor;
		tenantActor = (await getUserActor(tenantSession(), actorDb)) as TenantActor;
		staffActor = (await getUserActor(staffSession(), actorDb)) as StaffActor;
	});

	after(async () => {
		await cleanup();
	});

	test('no actor → 401 và không trả row', async () => {
		const r = await getReadings(null, { landlordId: LB });
		assert.equal(r.status, 401);
		assert.equal(Array.isArray(r.body), false);
	});

	test('landlord A không param → chỉ room của A', async () => {
		const r = await getReadings(landlordActor);
		assert.equal(r.status, 200);
		const ids = roomIdsOf(r.body);
		assert.ok(ids.length >= 2, 'A phải thấy các reading phòng A');
		assert.ok(
			ids.every((id) => id === RA),
			'mọi roomId phải thuộc scope A'
		);
		assert.ok(!ids.includes(RB), 'không được thấy phòng B');
	});

	test('landlord A gửi tenantId của B → KHÔNG lộ row B (containment)', async () => {
		const r = await getReadings(landlordActor, { tenantId: 'anything-b' });
		assert.equal(r.status, 200);
		assert.ok(roomIdsOf(r.body).every((id) => id === RA));
	});

	test('landlord A gửi landlordId=B → vẫn scoped A, query không mở rộng quyền', async () => {
		const r = await getReadings(landlordActor, { landlordId: LB });
		assert.equal(r.status, 200);
		assert.ok(roomIdsOf(r.body).every((id) => id === RA));
		assert.ok(!roomIdsOf(r.body).includes(RB));
	});

	test('tenant không có active tenancy → 403, không đọc lịch sử phòng', async () => {
		const r = await getReadings(tenantActor);
		assert.equal(r.status, 403);
		assert.equal(Array.isArray(r.body), false);
	});

	test('tenant gửi landlordId=B → vẫn 403, không lộ dữ liệu B', async () => {
		const r = await getReadings(tenantActor, { landlordId: LB });
		assert.equal(r.status, 403);
		assert.equal(Array.isArray(r.body), false);
	});

	test('staff thiếu MANAGE_METERS → 403', async () => {
		const r = await getReadings(staffActor, { landlordId: LB });
		assert.equal(r.status, 403);
		assert.equal(Array.isArray(r.body), false);
	});

	test('super-admin bị chặn operational → 401, không dump toàn hệ thống', async () => {
		const r = await getReadings(superAdminActor());
		assert.equal(r.status, 401);
		assert.equal(Array.isArray(r.body), false);
	});

	test('super-admin kèm landlordId vẫn bị chặn operational → 401', async () => {
		const r = await getReadings(superAdminActor(), { landlordId: LA });
		assert.equal(r.status, 401);
		assert.equal(Array.isArray(r.body), false);
	});

	test('status/month filter không phá landlord scope', async () => {
		const r1 = await getReadings(landlordActor, { status: 'pending' });
		assert.equal(r1.status, 200);
		assert.ok(roomIdsOf(r1.body).every((id) => id === RA));
		const r2 = await getReadings(landlordActor, { month: '2026-05' });
		assert.equal(r2.status, 200);
		assert.ok(roomIdsOf(r2.body).every((id) => id === RA));
	});

	test('mọi roomId trong mọi response được authorize đều nằm trong scope', async () => {
		const ids = roomIdsOf((await getReadings(landlordActor)).body);
		assert.ok(ids.length > 0);
		assert.ok(ids.every((id) => id === RA));
	});

	test('GET là read-only: row count trước/sau không đổi', async () => {
		const before = (await db.select().from(meterReadings)).length;
		await getReadings(landlordActor);
		await getReadings(superAdminActor(), { landlordId: LA });
		const afterCount = (await db.select().from(meterReadings)).length;
		assert.equal(afterCount, before);
	});

	test('POST/PUT không regress: guard cơ bản còn nguyên (không mutate)', async () => {
		const before = (await db.select().from(meterReadings)).length;
		const putReq = new Request('http://localhost/api/meter-readings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'a13-mr-a-cur', action: 'approve' })
		});
		const putRes = await call(PUT, { request: putReq, locals: { actor: tenantActor } });
		assert.equal(putRes.status, 401);
		const postReq = new Request('http://localhost/api/meter-readings', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		const postRes = await call(POST, { request: postReq, locals: { actor: landlordActor } });
		assert.equal(postRes.status, 422);
		const afterCount = (await db.select().from(meterReadings)).length;
		assert.equal(afterCount, before);
	});
}
