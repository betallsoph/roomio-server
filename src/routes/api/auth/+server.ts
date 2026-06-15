import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { users, landlordProfiles, tenantProfiles, services } from '$lib/server/db/schema';
import { eq, or } from 'drizzle-orm';
import crypto from 'crypto';
import { createSession, destroySession } from '$lib/server/session';

// Helper to hash password using SHA-256
function hashPassword(password: string) {
	return crypto.createHash('sha256').update(password).digest('hex');
}

export const POST: RequestHandler = async ({ request, cookies }) => {
	try {
		const body = await request.json();
		const { action, email, phone, password, name, role } = body;

		if (action === 'register') {
			if (!email || !phone || !password || !name) {
				return json({ error: 'Thiếu thông tin đăng ký bắt buộc' }, { status: 400 });
			}

			// Check if user already exists
			const existingUser = await db.query.users.findFirst({
				where: or(eq(users.email, email), eq(users.phone, phone))
			});

			if (existingUser) {
				return json({ error: 'Email hoặc số điện thoại đã được đăng ký' }, { status: 400 });
			}

			const passwordHash = hashPassword(password);
			const userRole = role || 'LANDLORD'; // Default to LANDLORD

			const user = await db.transaction(async (tx) => {
				const newUser = (
					await tx
						.insert(users)
						.values({ email, phone, passwordHash, name, role: userRole })
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
								companyName: `${name} PMS`,
								bankName: 'Vietcombank',
								bankCode: 'VCB',
								accountNumber: '1234567890',
								accountName: name.toUpperCase(),
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
				staffProfileId: null
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
			if (email) conditions.push(eq(users.email, email));
			if (phone) conditions.push(eq(users.phone, phone));

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

			const inputHash = hashPassword(password);
			if (user.passwordHash !== inputHash) {
				return json({ error: 'Mật khẩu không chính xác' }, { status: 401 });
			}

			if (!user.isActive) {
				return json({ error: 'Tài khoản đã bị tạm khóa' }, { status: 403 });
			}

			createSession(cookies, {
				userId: user.id,
				role: user.role,
				landlordProfileId: user.landlordProfile?.id || null,
				tenantProfileId: user.tenantProfile?.id || null,
				staffProfileId: user.staffProfile?.id || null
			});

			return json({
				id: user.id,
				email: user.email,
				phone: user.phone,
				name: user.name,
				role: user.role,
				landlordProfileId: user.landlordProfile?.id || null,
				tenantProfileId: user.tenantProfile?.id || null,
				staffProfileId: user.staffProfile?.id || null
			});
		}

		return json({ error: 'Hành động không hợp lệ' }, { status: 400 });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
