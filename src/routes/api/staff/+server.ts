import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { users, staffProfiles } from '$lib/server/db/schema';
import { eq, or } from 'drizzle-orm';
import { hashPassword } from '$lib/server/password';
import { listStaffAssignmentsPermissions } from '$lib/server/staff/assignments';
import { deactivateStaff, deactivateStaffTx } from '$lib/server/staff/lifecycle';
import { appendAudit } from '$lib/server/audit/append';
import { auditActorFromUserActor } from '$lib/server/audit/actors';
import {
	resolveLandlordActorFromRequest,
	staffRouteErrorResponse
} from '$lib/server/staff/landlord-request';
import {
	assertStaffOwnedByLandlord,
	StaffResourceNotFoundError
} from '$lib/server/staff/assignments';
import { AuditValidationError } from '$lib/server/audit/metadata';

// Cột User công khai cho UI (không trả passwordHash)
const STAFF_USER_COLUMNS = {
	id: true,
	name: true,
	email: true,
	phone: true,
	isActive: true
} as const;

// Danh sách nhân viên của landlord trong ActorContext (không tin query landlordId)
export const GET: RequestHandler = async ({ locals }) => {
	try {
		const guard = resolveLandlordActorFromRequest({ actor: locals.actor });
		if (!guard.ok) {
			return guard.response;
		}
		const landlordId = guard.actor.landlordId;

		const staff = await db.query.staffProfiles.findMany({
			where: eq(staffProfiles.landlordId, landlordId),
			with: { user: { columns: STAFF_USER_COLUMNS } }
		});

		staff.sort((a, b) => a.user.name.localeCompare(b.user.name, 'vi'));

		const enriched = await Promise.all(
			staff.map(async (row) => {
				const { propertyIds, permissions } = await listStaffAssignmentsPermissions(
					row.id,
					landlordId
				);
				return { ...row, propertyIds, permissions };
			})
		);

		return json(enriched);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

// Chủ trọ tạo tài khoản nhân viên mới (User role STAFF + StaffProfile)
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = resolveLandlordActorFromRequest({ actor: locals.actor });
		if (!guard.ok) {
			return guard.response;
		}
		const actor = guard.actor;
		const landlordId = actor.landlordId;

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

			await appendAudit(tx, auditActorFromUserActor(actor), {
				scope: 'LANDLORD',
				action: 'STAFF.CREATED',
				resourceType: 'StaffProfile',
				resourceId: profile.id,
				landlordId,
				metadata: { userId: user.id }
			});

			return profile;
		});

		const full = await db.query.staffProfiles.findFirst({
			where: eq(staffProfiles.id, created.id),
			with: { user: { columns: STAFF_USER_COLUMNS } }
		});

		if (!full) {
			return json({ error: 'Không tìm thấy nhân viên' }, { status: 404 });
		}

		const { propertyIds, permissions } = await listStaffAssignmentsPermissions(full.id, landlordId);

		return json({ ...full, propertyIds, permissions });
	} catch (error) {
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

// Sửa thông tin nhân viên; isActive=false đi qua deactivateStaff (revoke grants + audit)
export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = resolveLandlordActorFromRequest({ actor: locals.actor });
		if (!guard.ok) {
			return guard.response;
		}
		const actor = guard.actor;

		const body = await request.json();
		const { id, name, phone, email, password, isActive } = body;

		if (!id || typeof id !== 'string') {
			return json({ error: 'Thiếu ID nhân viên' }, { status: 400 });
		}

		await db.transaction(async (tx) => {
			const profile = await assertStaffOwnedByLandlord(tx, id, actor.landlordId);

			if (isActive === false) {
				await deactivateStaffTx(tx, actor, id);
			}

			const updateData: Record<string, unknown> = {};
			if (name !== undefined) updateData.name = name;
			if (phone !== undefined) updateData.phone = phone;
			if (email !== undefined) updateData.email = email;
			if (password) updateData.passwordHash = await hashPassword(password);
			if (isActive === true) updateData.isActive = true;

			if (Object.keys(updateData).length > 0) {
				await tx.update(users).set(updateData).where(eq(users.id, profile.userId));
			}
		});

		const full = await db.query.staffProfiles.findFirst({
			where: eq(staffProfiles.id, id),
			with: { user: { columns: STAFF_USER_COLUMNS } }
		});

		if (!full) {
			return json({ error: 'Không tìm thấy nhân viên' }, { status: 404 });
		}

		const { propertyIds, permissions } = await listStaffAssignmentsPermissions(
			full.id,
			actor.landlordId
		);

		return json({ ...full, propertyIds, permissions });
	} catch (error) {
		const mapped = staffRouteErrorResponse(error);
		if (mapped) return mapped;
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

// Soft-deactivate: User.isActive=false + revoke grants; never hard-delete User/StaffProfile
export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = resolveLandlordActorFromRequest({ actor: locals.actor });
		if (!guard.ok) {
			return guard.response;
		}

		const id = url.searchParams.get('id');
		if (!id) {
			return json({ error: 'Thiếu ID nhân viên' }, { status: 400 });
		}

		const result = await deactivateStaff(db, guard.actor, id);
		return json({ success: true, ...result });
	} catch (error) {
		const mapped = staffRouteErrorResponse(error);
		if (mapped) return mapped;
		if (error instanceof StaffResourceNotFoundError) {
			return json({ error: error.message }, { status: 404 });
		}
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
