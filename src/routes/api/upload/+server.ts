import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getEnv } from '$lib/server/env';
import { db } from '$lib/server/db';
import { requireOperationalActor } from '$lib/server/property-scope';
import {
	assertSafeLocalFileName,
	authorizeUploadResourceContext,
	isFileAccessDeniedError,
	mapUploadScopeError,
	normalizeUploadPurpose,
	parseUploadResourceContext
} from '$lib/server/file-access';
import { appendAudit, auditActorFromUserActor } from '$lib/server/audit';
import { AuditValidationError } from '$lib/server/audit/metadata';

const UPLOAD_DIR = getEnv().uploadDir;
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

const EXT_BY_TYPE: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'application/pdf': 'pdf'
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;

		const formData = await request.formData();
		const file = formData.get('file');
		const purpose = normalizeUploadPurpose(formData.get('purpose'));
		const resourceContext = parseUploadResourceContext(
			{
				resourceType: formData.get('resourceType'),
				resourceId: formData.get('resourceId'),
				managedTenantId: formData.get('managedTenantId'),
				tenancyId: formData.get('tenancyId')
			},
			purpose
		);

		let auditLandlordId: string;
		try {
			({ landlordId: auditLandlordId } = await authorizeUploadResourceContext(
				db,
				actorResult.actor,
				resourceContext
			));
		} catch (error) {
			mapUploadScopeError(error);
		}

		if (!(file instanceof File)) {
			return json({ error: 'Thiếu file upload' }, { status: 400 });
		}

		const ext = EXT_BY_TYPE[file.type];
		if (!ext) {
			return json({ error: 'Chỉ chấp nhận ảnh JPEG, PNG, WebP hoặc file PDF' }, { status: 400 });
		}

		if (file.size > MAX_SIZE) {
			return json({ error: 'File vượt quá 5MB.' }, { status: 400 });
		}

		const name = `${crypto.randomUUID()}.${ext}`;
		assertSafeLocalFileName(name);
		const objectKey = path.posix.join('uploads', purpose, name);

		await db.transaction(async (tx) => {
			await fs.mkdir(UPLOAD_DIR, { recursive: true });
			await fs.writeFile(path.join(UPLOAD_DIR, name), Buffer.from(await file.arrayBuffer()));

			await appendAudit(tx, auditActorFromUserActor(actorResult.actor), {
				scope: 'LANDLORD',
				action: 'FILE.UPLOADED',
				resourceType: resourceContext.resourceType,
				resourceId: resourceContext.resourceId,
				landlordId: auditLandlordId,
				requestId: locals.requestId,
				metadata: { objectKey, purpose }
			});
		});

		return json({ objectKey, expiresIn: null });
	} catch (error) {
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		if (isFileAccessDeniedError(error)) {
			return json({ error: error.message }, { status: 403 });
		}
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
