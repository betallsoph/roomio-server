import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { landlordProfiles, staffProfiles, tenantProfiles, users } from '$lib/server/db/schema';
import { eq, or } from 'drizzle-orm';
import { createSession, destroySession } from '$lib/server/session';
import { hashPassword, verifyPassword } from '$lib/server/password';
import { requiredEmail, requiredPhone, ValidationError } from '$lib/server/validation';

type EnvSuperAdmin = {
	id: string;
	email: string;
	password: string;
	name: string;
};

const ENV_SUPER_ADMIN_ID = 'env-super-admin';
const DEMO_LOGIN_DISABLED_MESSAGE = 'Demo login chưa được bật';
const DEMO_LOGIN_NOT_READY_MESSAGE = 'Demo account chưa sẵn sàng';

function getEnvSuperAdmins(): EnvSuperAdmin[] {
	const accounts = process.env.SUPER_ADMIN_ACCOUNTS?.split(',')
		.map((raw) => raw.trim())
		.filter(Boolean);

	if (!accounts?.length) return [];

	return accounts.map((account, index) => {
		const [email, password, name] = account.split(':').map((part) => part?.trim());
		if (!email || !password) {
			throw new Error(`SUPER_ADMIN_ACCOUNTS item #${index + 1} phải có dạng email:password[:name]`);
		}
		return {
			// Nhiều thông tin đăng nhập, nhưng tất cả cùng đại diện cho một Super Admin Roomio.
			id: ENV_SUPER_ADMIN_ID,
			email: email.toLowerCase(),
			password,
			name: name || 'Super Admin'
		};
	});
}

export const POST: RequestHandler = async ({ request, cookies }) => {
	try {
		const body = await request.json();
		const { action, email, phone, password } = body;

		if (action === 'register') {
			return json(
				{ error: 'Tài khoản chủ trọ chỉ được tạo bởi SuperAdmin Roomio.' },
				{ status: 403 }
			);
		} else if (action === 'logout') {
			destroySession(cookies);
			return json({ success: true });
		} else if (action === 'demo-login') {
			const demoEmail = process.env.DEMO_LOGIN_EMAIL?.trim();
			if (!demoEmail) {
				return json({ error: DEMO_LOGIN_DISABLED_MESSAGE }, { status: 403 });
			}

			const user = await db.query.users.findFirst({
				where: eq(users.email, requiredEmail(demoEmail))
			});

			if (!user || user.role !== 'LANDLORD' || !user.isActive) {
				return json({ error: DEMO_LOGIN_NOT_READY_MESSAGE }, { status: 404 });
			}

			const landlordProfile = await db.query.landlordProfiles.findFirst({
				where: eq(landlordProfiles.userId, user.id)
			});

			if (!landlordProfile) {
				return json({ error: DEMO_LOGIN_NOT_READY_MESSAGE }, { status: 404 });
			}

			createSession(cookies, {
				userId: user.id,
				role: user.role,
				landlordProfileId: landlordProfile.id,
				enabledRentalTypes: landlordProfile.enabledRentalTypes || null,
				tenantProfileId: null,
				staffProfileId: null,
				staffLandlordId: null
			});

			return json({
				id: user.id,
				email: user.email,
				phone: user.phone,
				name: user.name,
				role: user.role,
				landlordProfileId: landlordProfile.id,
				enabledRentalTypes: landlordProfile.enabledRentalTypes || null,
				tenantProfileId: null,
				staffProfileId: null,
				staffLandlordId: null
			});
		} else if (action === 'login') {
			if ((!email && !phone) || !password) {
				return json({ error: 'Thiếu tài khoản hoặc mật khẩu' }, { status: 400 });
			}

			if (email) {
				const superAdmin = getEnvSuperAdmins().find(
					(admin) => admin.email === requiredEmail(email) && admin.password === password
				);

				if (superAdmin) {
					createSession(cookies, {
						userId: superAdmin.id,
						role: 'SUPER_ADMIN',
						landlordProfileId: null,
						enabledRentalTypes: null,
						tenantProfileId: null,
						staffProfileId: null,
						staffLandlordId: null
					});

					return json({
						id: superAdmin.id,
						email: superAdmin.email,
						phone: null,
						name: superAdmin.name,
						role: 'SUPER_ADMIN',
						landlordProfileId: null,
						enabledRentalTypes: null,
						tenantProfileId: null,
						staffProfileId: null,
						staffLandlordId: null
					});
				}
			}

			const conditions = [];
			if (email) conditions.push(eq(users.email, requiredEmail(email)));
			if (phone) conditions.push(eq(users.phone, requiredPhone(phone)));

			const user = await db.query.users.findFirst({ where: or(...conditions) });

			if (!user) {
				return json({ error: 'Tài khoản không tồn tại' }, { status: 401 });
			}

			const { valid, needsRehash } = await verifyPassword(password, user.passwordHash);
			if (!valid) {
				return json({ error: 'Mật khẩu không chính xác' }, { status: 401 });
			}

			if (!user.isActive) {
				return json({ error: 'Tài khoản đã bị tạm khóa' }, { status: 403 });
			}

			// Nâng cấp mượt: tài khoản còn hash SHA-256 cũ thì băm lại sang bcrypt sau khi đăng nhập đúng
			if (needsRehash) {
				await db
					.update(users)
					.set({ passwordHash: await hashPassword(password) })
					.where(eq(users.id, user.id));
			}

			const landlordProfile =
				user.role === 'LANDLORD'
					? await db.query.landlordProfiles.findFirst({
							where: eq(landlordProfiles.userId, user.id)
						})
					: null;
			const tenantProfile =
				user.role === 'TENANT'
					? await db.query.tenantProfiles.findFirst({ where: eq(tenantProfiles.userId, user.id) })
					: null;
			const staffProfile =
				user.role === 'STAFF'
					? await db.query.staffProfiles.findFirst({ where: eq(staffProfiles.userId, user.id) })
					: null;

			createSession(cookies, {
				userId: user.id,
				role: user.role,
				landlordProfileId: landlordProfile?.id || null,
				enabledRentalTypes: landlordProfile?.enabledRentalTypes || null,
				tenantProfileId: tenantProfile?.id || null,
				staffProfileId: staffProfile?.id || null,
				staffLandlordId: staffProfile?.landlordId || null
			});

			return json({
				id: user.id,
				email: user.email,
				phone: user.phone,
				name: user.name,
				role: user.role,
				landlordProfileId: landlordProfile?.id || null,
				enabledRentalTypes: landlordProfile?.enabledRentalTypes || null,
				tenantProfileId: tenantProfile?.id || null,
				staffProfileId: staffProfile?.id || null,
				staffLandlordId: staffProfile?.landlordId || null
			});
		}

		return json({ error: 'Hành động không hợp lệ' }, { status: 400 });
	} catch (error) {
		if (error instanceof ValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
