import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'fs/promises';
import path from 'path';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? 'uploads';

const CONTENT_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp'
};

// Tên file do server sinh ra (uuid.ext) — regex này đồng thời chặn path traversal
const NAME_PATTERN = /^[a-f0-9-]+\.(jpg|png|webp)$/;

export const GET: RequestHandler = async ({ params }) => {
	const { name } = params;

	if (!NAME_PATTERN.test(name)) {
		throw error(400, 'Tên file không hợp lệ');
	}

	try {
		const data = await fs.readFile(path.join(UPLOAD_DIR, name));
		const ext = name.split('.').pop() as string;

		return new Response(new Uint8Array(data), {
			headers: {
				'Content-Type': CONTENT_TYPES[ext],
				'Cache-Control': 'private, max-age=86400'
			}
		});
	} catch {
		throw error(404, 'Không tìm thấy file');
	}
};
