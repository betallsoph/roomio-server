import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errorMessage } from '$lib/server/api';
import { createR2PresignedUpload } from '$lib/server/r2';
import { db } from '$lib/server/db';
import { requireOperationalActor } from '$lib/server/property-scope';
import {
	authorizeUploadResourceContext,
	isFileAccessDeniedError,
	mapUploadScopeError,
	normalizeUploadPurpose,
	parseUploadResourceContext
} from '$lib/server/file-access';
import { appendAudit, auditActorFromUserActor } from '$lib/server/audit';
import { AuditValidationError } from '$lib/server/audit/metadata';

function actorUploadIdentity(actor: {
	role: string;
	userId: string;
	landlordId?: string;
	staffId?: string;
	tenantProfileId?: string;
}): { id: string; role: string } {
	if (actor.role === 'TENANT' && actor.tenantProfileId) {
		return { id: actor.tenantProfileId, role: actor.role };
	}
	if (actor.role === 'LANDLORD' && actor.landlordId) {
		return { id: actor.landlordId, role: actor.role };
	}
	if (actor.role === 'STAFF' && actor.staffId) {
		return { id: actor.staffId, role: actor.role };
	}
	return { id: actor.userId, role: actor.role };
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const actorResult = requireOperationalActor(locals.actor);
		if (!actorResult.ok) return actorResult.response;
		const actor = actorResult.actor;

		const body = await request.json();
		const purpose = normalizeUploadPurpose(body.purpose);
		const resourceContext = parseUploadResourceContext(body, purpose);

		let auditLandlordId: string;
		try {
			({ landlordId: auditLandlordId } = await authorizeUploadResourceContext(
				db,
				actor,
				resourceContext
			));
		} catch (error) {
			mapUploadScopeError(error);
		}

		const uploadActor = actorUploadIdentity(actor);
		const signedUpload = await createR2PresignedUpload({
			purpose,
			contentType: body.contentType,
			byteSize: body.byteSize,
			actorId: uploadActor.id,
			actorRole: uploadActor.role
		});

		await db.transaction(async (tx) => {
			await appendAudit(tx, auditActorFromUserActor(actor), {
				scope: 'LANDLORD',
				action: 'FILE.PRESIGNED_ISSUED',
				resourceType: resourceContext.resourceType,
				resourceId: resourceContext.resourceId,
				landlordId: auditLandlordId,
				requestId: locals.requestId,
				metadata: {
					objectKey: signedUpload.objectKey,
					purpose,
					expiresIn: signedUpload.expiresIn
				}
			});
		});

		return json(signedUpload);
	} catch (error) {
		if (error instanceof AuditValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		if (isFileAccessDeniedError(error)) {
			return json({ error: error.message }, { status: 403 });
		}
		const message = errorMessage(error);
		const status = message.includes('Thiếu biến môi trường') || message.includes('R2_') ? 500 : 400;
		return json({ error: message }, { status });
	}
};
