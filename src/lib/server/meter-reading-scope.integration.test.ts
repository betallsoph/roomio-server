import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';

// AUTH-013 PostgreSQL integration test cho GET /api/meter-readings.
//
// An toàn: CHỈ chạy khi DATABASE_URL trỏ tới Postgres localhost có tên DB đánh dấu test
// (auth013/test/disposable). Nếu không, test tự skip với lý do BLOCKED_INTEGRATION_TEST —
// không bao giờ đụng DB thật/production và không bịa kết quả.

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

// Fixed fixture IDs (dữ liệu giả, không phải người thật).
// Khai báo `string` để TypeScript không suy literal type rồi narrow mảng trong assertion.
const U_LA: string = 'a13-u-la';
const U_LB: string = 'a13-u-lb';
const U_TC: string = 'a13-u-tc';
const LA: string = 'a13-la'; // landlord A
const LB: string = 'a13-lb'; // landlord B
const TC: string = 'a13-tc'; // tenant hiện tại của phòng A
const PA: string = 'a13-pa';
const PB: string = 'a13-pb';
const RA: string = 'a13-ra'; // room A (landlord A)
const RB: string = 'a13-rb'; // room B (landlord B)
const SA: string = 'a13-sa';
const SB: string = 'a13-sb';

type Session = {
	userId: string;
	role: string;
	landlordProfileId: string | null;
	tenantProfileId: string | null;
	staffProfileId: string | null;
	staffLandlordId: string | null;
};
function sess(role: string, over: Partial<Session> = {}): Session {
	return {
		userId: 'u-' + role,
		role,
		landlordProfileId: null,
		tenantProfileId: null,
		staffProfileId: null,
		staffLandlordId: null,
		...over
	};
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
	const { users, landlordProfiles, tenantProfiles, properties, rooms, services, meterReadings } =
		await import('./db/schema.js');
	const { inArray } = await import('drizzle-orm');

	async function cleanup() {
		// Xoá User đã seed → cascade toàn bộ profile/property/room/service/meter reading.
		await db.delete(users).where(inArray(users.id, [U_LA, U_LB, U_TC]));
	}

	async function call(handler: unknown, event: Record<string, unknown>): Promise<Response> {
		return (handler as (e: unknown) => Promise<Response>)(event);
	}
	async function getReadings(session: Session | null, params: Record<string, string> = {}) {
		const qs = new URLSearchParams(params).toString();
		const url = new URL(`http://localhost/api/meter-readings${qs ? '?' + qs : ''}`);
		const res = await call(GET, { url, locals: { session } });
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
				role: 'LANDLORD'
			},
			{
				id: U_LB,
				email: 'a13-lb@test.local',
				phone: 'a13-000002',
				passwordHash: 'x',
				name: 'LB',
				role: 'LANDLORD'
			},
			{
				id: U_TC,
				email: 'a13-tc@test.local',
				phone: 'a13-000003',
				passwordHash: 'x',
				name: 'TC',
				role: 'TENANT'
			}
		]);
		await db.insert(landlordProfiles).values([
			{ id: LA, userId: U_LA },
			{ id: LB, userId: U_LB }
		]);
		await db
			.insert(tenantProfiles)
			.values([{ id: TC, userId: U_TC, idNumber: 'A13-ID', moveInDate: '2026-01-01', deposit: 0 }]);
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
			// Phòng A: một bản ghi CŨ (thời khách trước) + một bản ghi hiện tại.
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
			// Phòng B thuộc landlord B.
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
	});

	after(async () => {
		await cleanup();
	});

	const landlordA = sess('LANDLORD', { userId: U_LA, landlordProfileId: LA });
	const staffA = sess('STAFF', { staffLandlordId: LA });
	const tenantCurrent = sess('TENANT', { userId: U_TC, tenantProfileId: TC });

	test('no session → 401 và không trả row', async () => {
		const r = await getReadings(null, { landlordId: LB });
		assert.equal(r.status, 401);
		assert.equal(Array.isArray(r.body), false);
	});

	test('landlord A không param → chỉ room của A', async () => {
		const r = await getReadings(landlordA);
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
		const r = await getReadings(landlordA, { tenantId: 'anything-b' });
		assert.equal(r.status, 200);
		assert.ok(roomIdsOf(r.body).every((id) => id === RA));
	});

	test('landlord A gửi landlordId=B → 403, không trả row', async () => {
		const r = await getReadings(landlordA, { landlordId: LB });
		assert.equal(r.status, 403);
		assert.equal(Array.isArray(r.body), false);
	});

	test('tenant hiện tại → 403 TENANCY_HISTORY_NOT_READY, không đọc cả lịch sử khách cũ cùng phòng', async () => {
		const r = await getReadings(tenantCurrent);
		assert.equal(r.status, 403);
		assert.equal(Array.isArray(r.body), false);
		assert.equal((r.body as { code?: string }).code, 'TENANCY_HISTORY_NOT_READY');
	});

	test('tenant gửi landlordId=B → vẫn 403, không lộ dữ liệu B', async () => {
		const r = await getReadings(tenantCurrent, { landlordId: LB });
		assert.equal(r.status, 403);
		assert.equal(Array.isArray(r.body), false);
	});

	test('staff A bị fail closed tới khi có property assignment scope', async () => {
		const r = await getReadings(staffA, { landlordId: LB });
		assert.equal(r.status, 403);
		assert.equal(Array.isArray(r.body), false);
		assert.equal((r.body as { code?: string }).code, 'STAFF_SCOPE_NOT_READY');
	});

	test('super-admin thiếu explicit scope → 400, không dump toàn hệ thống', async () => {
		const r = await getReadings(sess('SUPER_ADMIN', { userId: 'admin' }));
		assert.equal(r.status, 400);
		assert.equal(Array.isArray(r.body), false);
	});

	test('super-admin scope A → chỉ A', async () => {
		const r = await getReadings(sess('SUPER_ADMIN', { userId: 'admin' }), { landlordId: LA });
		assert.equal(r.status, 200);
		assert.ok(roomIdsOf(r.body).every((id) => id === RA));
		assert.ok(!roomIdsOf(r.body).includes(RB));
	});

	test('status/month filter không phá landlord scope', async () => {
		const r1 = await getReadings(landlordA, { status: 'pending' });
		assert.equal(r1.status, 200);
		assert.ok(roomIdsOf(r1.body).every((id) => id === RA));
		const r2 = await getReadings(landlordA, { month: '2026-05' });
		assert.equal(r2.status, 200);
		assert.ok(roomIdsOf(r2.body).every((id) => id === RA));
	});

	test('mọi roomId trong mọi response được authorize đều nằm trong scope', async () => {
		for (const s of [landlordA]) {
			const ids = roomIdsOf((await getReadings(s)).body);
			assert.ok(ids.every((id) => id === RA));
		}
	});

	test('GET là read-only: row count trước/sau không đổi', async () => {
		const before = (await db.select().from(meterReadings)).length;
		await getReadings(landlordA);
		await getReadings(sess('SUPER_ADMIN', { userId: 'admin' }), { landlordId: LA });
		const afterCount = (await db.select().from(meterReadings)).length;
		assert.equal(afterCount, before);
	});

	test('POST/PUT không regress: guard cơ bản còn nguyên (không mutate)', async () => {
		const before = (await db.select().from(meterReadings)).length;
		// PUT với tenant vẫn bị chặn.
		const putReq = new Request('http://localhost/api/meter-readings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'a13-mr-a-cur', action: 'approve' })
		});
		const putRes = await call(PUT, { request: putReq, locals: { session: tenantCurrent } });
		assert.equal(putRes.status, 403);
		// POST thiếu field → 400, không tạo row.
		const postReq = new Request('http://localhost/api/meter-readings', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		const postRes = await call(POST, { request: postReq, locals: { session: landlordA } });
		assert.equal(postRes.status, 400);
		const afterCount = (await db.select().from(meterReadings)).length;
		assert.equal(afterCount, before);
	});
}
