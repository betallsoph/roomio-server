import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? 'uploads';
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

const EXT_BY_TYPE: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp'
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const formData = await request.formData();
		const file = formData.get('file');

		if (!(file instanceof File)) {
			return json({ error: 'Thiếu file upload' }, { status: 400 });
		}

		const ext = EXT_BY_TYPE[file.type];
		if (!ext) {
			return json({ error: 'Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP' }, { status: 400 });
		}

		if (file.size > MAX_SIZE) {
			return json({ error: 'Ảnh vượt quá 5MB. Vui lòng nén ảnh trước khi gửi.' }, { status: 400 });
		}

		const name = `${crypto.randomUUID()}.${ext}`;
		await fs.mkdir(UPLOAD_DIR, { recursive: true });
		await fs.writeFile(path.join(UPLOAD_DIR, name), Buffer.from(await file.arrayBuffer()));

		return json({ url: `/api/files/${name}` });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
