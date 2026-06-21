import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq, or } from 'drizzle-orm';
import { createSession, destroySession } from '$lib/server/session';
import { hashPassword, verifyPassword } from '$lib/server/password';
import { requiredEmail, requiredPhone, ValidationError } from '$lib/server/validation';

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
