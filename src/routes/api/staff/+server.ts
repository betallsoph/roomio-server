import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { users, staffProfiles } from '$lib/server/db/schema';
import { eq, or } from 'drizzle-orm';
import { hashPassword } from '$lib/server/password';
import { resolveLandlordScopeForList } from '$lib/server/landlord-query-scope';

// Cột User công khai cho UI (không trả passwordHash)
export const STAFF_USER_COLUMNS = {
	id: true,
	name: true,
	email: true,
	phone: true,
	isActive: true
} as const;

// Danh sách nhân viên của một chủ trọ
export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const scope = resolveLandlordScopeForList(
			locals.session,
			url.searchParams.get('landlordId')
		);
		if ('error' in scope) {
			return json({ error: scope.error }, { status: scope.status });
		}

		const staff = await db.query.staffProfiles.findMany({
			where: eq(staffProfiles.landlordId, scope.landlordId),
			with: { user: { columns: STAFF_USER_COLUMNS } }
		});

		staff.sort((a, b) => a.user.name.localeCompare(b.user.name, 'vi'));

		return json(staff);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

// Chủ trọ tạo tài khoản nhân viên mới (User role STAFF + StaffProfile)
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		// landlordId lấy từ phiên đăng nhập, không tin giá trị do client gửi
		const landlordId = locals.session?.landlordProfileId;
		if (locals.session?.role !== 'LANDLORD' || !landlordId) {
			return json({ error: 'Chỉ chủ trọ được quản lý nhân viên' }, { status: 403 });
		}

		const body = await request.json();
		const { email, phone, password, name } = body;

		if (!email || !phone || !password || !name) {
			return json({ error: 'Thiếu thông tin nhân viên bắt buộc' }, { status: 400 });
		}

		const existingUser = await db.query.users.findFirst({
			where: or(eq(users.email, email), eq(users.phone, phone))
		});
		if (existingUser) {
			return json({ error: 'Email hoặc số điện thoại đã được sử dụng' }, { status: 400 });
		}

		const passwordHash = await hashPassword(password);

		const created = await db.transaction(async (tx) => {
			const user = (
				await tx
					.insert(users)
					.values({ email, phone, passwordHash, name, role: 'STAFF' })
					.returning()
			)[0];

			const profile = (
				await tx.insert(staffProfiles).values({ userId: user.id, landlordId }).returning()
			)[0];

			return profile;
		});

		const full = await db.query.staffProfiles.findFirst({
			where: eq(staffProfiles.id, created.id),
			with: { user: { columns: STAFF_USER_COLUMNS } }
		});

		return json(full);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

// Sửa thông tin nhân viên (tên, SĐT, email, đặt lại mật khẩu, khóa/mở)
export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json();
		const { id, name, phone, email, password, isActive } = body;

		if (!id) {
			return json({ error: 'Thiếu ID nhân viên' }, { status: 400 });
		}

		const profile = await db.query.staffProfiles.findFirst({
			where: eq(staffProfiles.id, id)
		});
		if (!profile) {
			return json({ error: 'Không tìm thấy nhân viên' }, { status: 404 });
		}

		// Chỉ chủ trọ sở hữu nhân viên này được sửa
		if (
			locals.session?.role !== 'LANDLORD' ||
			profile.landlordId !== locals.session.landlordProfileId
		) {
			return json({ error: 'Không có quyền sửa nhân viên này' }, { status: 403 });
		}

		const updateData: Record<string, unknown> = {};
		if (name !== undefined) updateData.name = name;
		if (phone !== undefined) updateData.phone = phone;
		if (email !== undefined) updateData.email = email;
		if (isActive !== undefined) updateData.isActive = isActive;
		if (password) updateData.passwordHash = await hashPassword(password);

		if (Object.keys(updateData).length > 0) {
			await db.update(users).set(updateData).where(eq(users.id, profile.userId));
		}

		const full = await db.query.staffProfiles.findFirst({
			where: eq(staffProfiles.id, id),
			with: { user: { columns: STAFF_USER_COLUMNS } }
		});

		return json(full);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

// Xóa nhân viên: xóa User (cascade xóa StaffProfile; assignedToId của sự cố tự set null)
export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const id = url.searchParams.get('id');
		if (!id) {
			return json({ error: 'Thiếu ID nhân viên' }, { status: 400 });
		}

		const profile = await db.query.staffProfiles.findFirst({
			where: eq(staffProfiles.id, id)
		});
		if (!profile) {
			return json({ error: 'Không tìm thấy nhân viên' }, { status: 404 });
		}

		if (
			locals.session?.role !== 'LANDLORD' ||
			profile.landlordId !== locals.session.landlordProfileId
		) {
			return json({ error: 'Không có quyền xóa nhân viên này' }, { status: 403 });
		}

		await db.delete(users).where(eq(users.id, profile.userId));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
