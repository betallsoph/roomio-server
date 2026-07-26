import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errorMessage } from '$lib/server/api';
import { parseMeterReadingFromImageUrl } from '$lib/server/meter-ocr';
import { isOcrConfigured } from '$lib/server/env';

function canParseMeterPhoto(session: App.Locals['session']) {
	return session?.role === 'TENANT' || session?.role === 'LANDLORD';
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!canParseMeterPhoto(locals.session)) {
			return json({ error: 'Không có quyền OCR chỉ số' }, { status: 403 });
		}

		if (!isOcrConfigured()) {
			return json({ error: 'OCR chưa được cấu hình' }, { status: 503 });
		}

		const body = await request.json();
		const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl.trim() : '';
		if (!photoUrl) {
			return json({ error: 'Thiếu URL ảnh' }, { status: 400 });
		}

		const result = await parseMeterReadingFromImageUrl(photoUrl);
		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
