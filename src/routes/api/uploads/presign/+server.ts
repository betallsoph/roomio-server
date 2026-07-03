import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errorMessage } from '$lib/server/api';
import { createR2PresignedUpload } from '$lib/server/r2';

function actorFromSession(session: App.Locals['session']) {
	if (!session) return null;

	if (session.role === 'TENANT' && session.tenantProfileId) {
		return { id: session.tenantProfileId, role: session.role };
	}
	if (session.role === 'LANDLORD' && session.landlordProfileId) {
		return { id: session.landlordProfileId, role: session.role };
	}
	if (session.role === 'STAFF' && session.staffProfileId) {
		return { id: session.staffProfileId, role: session.role };
	}

	return { id: session.userId, role: session.role };
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const actor = actorFromSession(locals.session);
		if (!actor) {
			return json({ error: 'Chưa đăng nhập' }, { status: 401 });
		}

		const body = await request.json();
		const signedUpload = await createR2PresignedUpload({
			purpose: body.purpose,
			contentType: body.contentType,
			byteSize: body.byteSize,
			actorId: actor.id,
			actorRole: actor.role
		});

		return json(signedUpload);
	} catch (error) {
		const message = errorMessage(error);
		const status = message.includes('Thiếu biến môi trường') || message.includes('R2_') ? 500 : 400;
		return json({ error: message }, { status });
	}
};
