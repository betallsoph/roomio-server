import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { users, landlordProfiles, tenantProfiles, services } from '$lib/server/db/schema';
import { eq, or } from 'drizzle-orm';
import { createSession, destroySession } from '$lib/server/session';
import { hashPassword, verifyPassword } from '$lib/server/password';
import { requiredEmail, requiredPhone, requiredString, ValidationError } from '$lib/server/validation';

export const POST: RequestHandler = async ({ request, cookies }) => {
	try {
		const body = await request.json();
		const { action, email, phone, password, name, role } = body;

		if (action === 'register') {
			const cleanEmail = requiredEmail(email);
			const cleanPhone = requiredPhone(phone);
			const cleanPassword = requiredString(password, 'mật khẩu', 128);
			const cleanName = requiredString(name, 'họ tên', 120);

			if (role && role !== 'LANDLORD') {
				return json(
					{ error: 'Không thể tự đăng ký vai trò này. Vui lòng dùng luồng quản trị phù hợp.' },
					{ status: 403 }
				);
			}

			// Check if user already exists
			const existingUser = await db.query.users.findFirst({
				where: or(eq(users.email, cleanEmail), eq(users.phone, cleanPhone))
			});

			if (existingUser) {
				return json({ error: 'Email hoặc số điện thoại đã được đăng ký' }, { status: 400 });
			}

			const passwordHash = await hashPassword(cleanPassword);
			const userRole = 'LANDLORD';

			const user = await db.transaction(async (tx) => {
				const newUser = (
					await tx
						.insert(users)
						.values({
							email: cleanEmail,
							phone: cleanPhone,
							passwordHash,
							name: cleanName,
							role: userRole
						})
						.returning()
				)[0];

				let landlordProfileId: string | null = null;
				let tenantProfileId: string | null = null;

				if (userRole === 'LANDLORD') {
					const profile = (
						await tx
							.insert(landlordProfiles)
							.values({
								userId: newUser.id,
								companyName: `${cleanName} PMS`,
								bankName: 'Vietcombank',
								bankCode: 'VCB',
								accountNumber: '1234567890',
								accountName: cleanName.toUpperCase(),
								bankBranch: 'Chi nhánh TP.HCM'
							})
							.returning()
					)[0];
					landlordProfileId = profile.id;

					// Initialize default services for this landlord
					const defaultServices = [
						{ name: 'Điện', type: 'METERED', defaultRate: 3500 },
						{ name: 'Nước', type: 'METERED', defaultRate: 15000 },
						{ name: 'Wifi', type: 'FLAT_ROOM', defaultRate: 100000 },
						{ name: 'Rác sinh hoạt', type: 'FLAT_PERSON', defaultRate: 30000 },
						{ name: 'Gửi xe máy', type: 'FLAT_VEHICLE', defaultRate: 100000 }
					];

					await tx
						.insert(services)
						.values(defaultServices.map((s) => ({ ...s, landlordId: profile.id, isActive: true })));
				} else if (userRole === 'TENANT') {
					// Fallback if tenant signs up directly (usually landlord creates them)
					const profile = (
						await tx
							.insert(tenantProfiles)
							.values({
								userId: newUser.id,
								idNumber: '000000000000',
								moveInDate: new Date().toISOString().split('T')[0],
								deposit: 0,
								notes: 'Tự đăng ký qua cổng khách'
							})
							.returning()
					)[0];
					tenantProfileId = profile.id;
				}

				return {
					id: newUser.id,
					email: newUser.email,
					phone: newUser.phone,
					name: newUser.name,
					role: newUser.role,
					landlordProfileId,
					tenantProfileId
				};
			});

			createSession(cookies, {
				userId: user.id,
				role: user.role,
				landlordProfileId: user.landlordProfileId,
				tenantProfileId: user.tenantProfileId,
				staffProfileId: null,
				staffLandlordId: null
			});

			return json(user);
		} else if (action === 'logout') {
			destroySession(cookies);
			return json({ success: true });
		} else if (action === 'login') {
			if ((!email && !phone) || !password) {
				return json({ error: 'Thiếu tài khoản hoặc mật khẩu' }, { status: 400 });
			}

			const conditions = [];
			if (email) conditions.push(eq(users.email, requiredEmail(email)));
			if (phone) conditions.push(eq(users.phone, requiredPhone(phone)));

			const user = await db.query.users.findFirst({
				where: or(...conditions),
				with: {
					landlordProfile: true,
					tenantProfile: true,
					staffProfile: true
				}
			});

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

			createSession(cookies, {
				userId: user.id,
				role: user.role,
				landlordProfileId: user.landlordProfile?.id || null,
				tenantProfileId: user.tenantProfile?.id || null,
				staffProfileId: user.staffProfile?.id || null,
				staffLandlordId: user.staffProfile?.landlordId || null
			});

			return json({
				id: user.id,
				email: user.email,
				phone: user.phone,
				name: user.name,
				role: user.role,
				landlordProfileId: user.landlordProfile?.id || null,
				tenantProfileId: user.tenantProfile?.id || null,
				staffProfileId: user.staffProfile?.id || null,
				staffLandlordId: user.staffProfile?.landlordId || null
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
