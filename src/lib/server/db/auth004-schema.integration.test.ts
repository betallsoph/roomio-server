import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';

// AUTH-004 — kiểm constraint THẬT trên PostgreSQL. Chạy ở CI (job quality đã có postgres
// service và đã migrate từ 0) hoặc staging. Guard: chỉ chạy khi DATABASE_URL trỏ tới
// Postgres localhost có tên DB đánh dấu test; ngoài ra tự skip, không chạm DB thật.

const DB_URL = process.env.DATABASE_URL ?? '';

function isDisposableTestDb(raw: string): boolean {
	try {
		const parsed = new URL(raw);
		const localish = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
		return localish && /test|ci|disposable|auth004/i.test(parsed.pathname.replace(/^\//, ''));
	} catch {
		return false;
	}
}

const RUN = DB_URL.startsWith('postgres') && isDisposableTestDb(DB_URL);

if (!RUN) {
	test(
		'AUTH-004 schema constraints against real PostgreSQL',
		{ skip: 'PENDING_INTEGRATION: needs DATABASE_URL pointing at a disposable test database' },
		() => {}
	);
} else {
	const { Pool } = await import('pg');
	const pool = new Pool({ connectionString: DB_URL, max: 2 });

	const P = 'a4'; // prefix fixture, dữ liệu giả
	const q = (text: string, values: unknown[] = []) => pool.query(text, values);

	async function cleanup() {
		// Xoá theo thứ tự phụ thuộc; Tenancy dùng ON DELETE restrict nên phải xoá trước.
		await q(`DELETE FROM "Tenancy" WHERE id LIKE $1`, [`${P}-%`]);
		await q(`DELETE FROM "ManagedTenant" WHERE id LIKE $1`, [`${P}-%`]);
		await q(`DELETE FROM "Room" WHERE id LIKE $1`, [`${P}-%`]);
		await q(`DELETE FROM "Property" WHERE id LIKE $1`, [`${P}-%`]);
		await q(`DELETE FROM "LandlordProfile" WHERE id LIKE $1`, [`${P}-%`]);
		await q(`DELETE FROM "User" WHERE id LIKE $1`, [`${P}-%`]);
	}

	/** Insert tenancy; trả về lỗi (nếu có) thay vì ném, để assert constraint. */
	async function insertTenancy(over: Record<string, unknown> = {}): Promise<Error | null> {
		const row = {
			id: `${P}-t-${Math.round(performance.now() * 1000)}-${Object.keys(over).length}`,
			landlordId: `${P}-la`,
			propertyId: `${P}-pa`,
			roomId: `${P}-ra`,
			managedTenantId: `${P}-mt1`,
			status: 'ACTIVE',
			startDate: '2026-01-01',
			endDate: null as string | null,
			...over
		};
		try {
			await q(
				`INSERT INTO "Tenancy"
				 (id, "landlordId", "propertyId", "roomId", "managedTenantId", status, "startDate", "endDate", "createdAt", "updatedAt")
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())`,
				[
					row.id,
					row.landlordId,
					row.propertyId,
					row.roomId,
					row.managedTenantId,
					row.status,
					row.startDate,
					row.endDate
				]
			);
			return null;
		} catch (error) {
			return error as Error;
		}
	}

	before(async () => {
		await cleanup();
		await q(
			`INSERT INTO "User" (id, email, phone, "passwordHash", name, role, "isActive", "createdAt", "updatedAt")
			 VALUES ($1,$2,$3,'x','A4 User','TENANT',true, now(), now())`,
			[`${P}-u1`, `${P}-u1@test.local`, `${P}-p1`]
		);
		await q(
			`INSERT INTO "LandlordProfile" (id, "userId") VALUES ($1,$1)`.replace('$1,$1', '$1,$2'),
			[`${P}-la`, `${P}-u1`]
		);
		await q(
			`INSERT INTO "Property" (id, "landlordId", name, "shortName", address, "createdAt")
			 VALUES ($1,$2,'A4 Prop','A4','addr', now())`,
			[`${P}-pa`, `${P}-la`]
		);
		for (const roomId of [`${P}-ra`, `${P}-rb`]) {
			await q(
				`INSERT INTO "Room" (id, "propertyId", "roomNumber", "roomType", status, "monthlyRent")
				 VALUES ($1,$2,$3,'standard','empty',1)`,
				[roomId, `${P}-pa`, roomId]
			);
		}
		for (const mt of [`${P}-mt1`, `${P}-mt2`]) {
			await q(
				`INSERT INTO "ManagedTenant" (id, "landlordId", "displayName", "createdAt", "updatedAt")
				 VALUES ($1,$2,$3, now(), now())`,
				[mt, `${P}-la`, 'A4 Managed']
			);
		}
	});

	after(async () => {
		await cleanup();
		await pool.end();
	});

	test('a valid active tenancy inserts', async () => {
		const error = await insertTenancy({ id: `${P}-t-ok` });
		assert.equal(error, null, `unexpected: ${error?.message}`);
	});

	test('a second ACTIVE tenancy on the same room is rejected', async () => {
		const error = await insertTenancy({ id: `${P}-t-dup-room`, managedTenantId: `${P}-mt2` });
		assert.notEqual(error, null, 'second active tenancy on the room must fail');
		assert.match(String(error?.message), /Tenancy_active_room_unique/);
	});

	test('a second ACTIVE tenancy for the same managed tenant is rejected', async () => {
		const error = await insertTenancy({ id: `${P}-t-dup-mt`, roomId: `${P}-rb` });
		assert.notEqual(error, null, 'second active tenancy for the managed tenant must fail');
		assert.match(String(error?.message), /Tenancy_active_managedTenant_unique/);
	});

	test('an ENDED tenancy may reuse the same room and managed tenant', async () => {
		// Partial unique chỉ áp cho ACTIVE, nên lịch sử vẫn lưu được nhiều lần thuê.
		const error = await insertTenancy({
			id: `${P}-t-history`,
			status: 'ENDED',
			startDate: '2025-01-01',
			endDate: '2025-06-30'
		});
		assert.equal(error, null, `history row must be allowed: ${error?.message}`);
	});

	test('endDate before startDate is rejected by the check constraint', async () => {
		const error = await insertTenancy({
			id: `${P}-t-bad-dates`,
			roomId: `${P}-rb`,
			managedTenantId: `${P}-mt2`,
			status: 'ENDED',
			startDate: '2026-05-10',
			endDate: '2026-05-01'
		});
		assert.notEqual(error, null, 'endDate < startDate must fail');
		assert.match(String(error?.message), /Tenancy_ended_end_date_valid/);
	});

	test('an ACTIVE tenancy cannot carry an endDate', async () => {
		const error = await insertTenancy({
			id: `${P}-t-active-end`,
			roomId: `${P}-rb`,
			managedTenantId: `${P}-mt2`,
			status: 'ACTIVE',
			endDate: '2026-05-01'
		});
		assert.notEqual(error, null, 'ACTIVE with endDate must fail');
		assert.match(String(error?.message), /Tenancy_active_no_end_date/);
	});

	test('two managed tenants may share one claimedByUserId', async () => {
		// Một User được phép claim nhiều hồ sơ ở nhiều chủ trọ; KHÔNG unique trên cột này.
		await q(`UPDATE "ManagedTenant" SET "claimedByUserId" = $1 WHERE id IN ($2,$3)`, [
			`${P}-u1`,
			`${P}-mt1`,
			`${P}-mt2`
		]);
		const { rows } = await q(`SELECT count(*)::int AS n FROM "ManagedTenant" WHERE id LIKE $1`, [
			`${P}-mt%`
		]);
		assert.equal(rows[0].n, 2, 'both managed tenants must keep the same claimant');
	});

	test('two managed tenants may share the same contact snapshot', async () => {
		// Contact chỉ là dữ liệu vận hành: hai chủ trọ (hoặc legacy duplicate) dùng chung được.
		await q(
			`UPDATE "ManagedTenant" SET "emailSnapshot" = $1, "phoneSnapshot" = $2 WHERE id LIKE $3`,
			['same@test.local', '0900000000', `${P}-mt%`]
		);
		const { rows } = await q(
			`SELECT count(*)::int AS n FROM "ManagedTenant"
			 WHERE id LIKE $1 AND "emailSnapshot" = $2 AND "claimedByUserId" IS NOT NULL`,
			[`${P}-mt%`, 'same@test.local']
		);
		assert.equal(rows[0].n, 2, 'duplicate contact snapshots must be allowed');
	});

	test('legacy rows stay readable while the new snapshot columns are null', async () => {
		// Hàng rào chính của "additive": read path cũ không được vỡ vì cột mới.
		for (const table of [
			'Invoice',
			'Contract',
			'MaintenanceRequest',
			'MeterReading',
			'SpecialNote',
			'NotificationQueue'
		]) {
			const { rows } = await q(
				`SELECT count(*)::int AS n FROM "${table}" WHERE "managedTenantId" IS NULL AND "tenancyId" IS NULL`
			);
			assert.equal(typeof rows[0].n, 'number', `${table} must remain readable`);
		}
		const room = await q(
			`SELECT count(*)::int AS n FROM "Room" WHERE "currentManagedTenantId" IS NULL`
		);
		assert.equal(typeof room.rows[0].n, 'number');
	});

	test('the invite pending-per-tenancy and tokenHash uniques exist and are partial', async () => {
		const { rows } = await q(
			`SELECT indexname, indexdef FROM pg_indexes
			 WHERE tablename = 'TenantInvite' AND indexname IN
			   ('TenantInvite_tokenHash_unique','TenantInvite_pending_per_tenancy_unique')`
		);
		assert.equal(rows.length, 2, 'both partial unique indexes must exist');
		for (const row of rows) assert.match(row.indexdef, /WHERE/, `${row.indexname} must be partial`);
	});

	test('contact snapshot columns carry no unique index', async () => {
		const { rows } = await q(
			`SELECT indexdef FROM pg_indexes WHERE tablename = 'ManagedTenant' AND indexdef ILIKE '%UNIQUE%'`
		);
		for (const row of rows) {
			assert.equal(/emailSnapshot|phoneSnapshot/i.test(row.indexdef), false, row.indexdef);
			assert.equal(
				/UNIQUE.*\("claimedByUserId"\)/i.test(row.indexdef),
				false,
				`claimedByUserId must not be unique: ${row.indexdef}`
			);
		}
	});
}
