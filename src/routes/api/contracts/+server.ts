import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { contracts, rooms, properties } from '$lib/server/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
	forbidden,
	landlordOwnsContract,
	landlordOwnsRoom,
	landlordOwnsTenant,
	requireLandlord
} from '$lib/server/authz';
import { toContractDto } from '$lib/server/dto/contract';
import { getPaymentAccountForLandlord } from '$lib/server/payment-accounts';
import { requireLandlordActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	unauthenticatedError
} from '$lib/server/authorization/errors';
import { isTenancyDualWriteEnabled } from '$lib/server/env';
import {
	createContractForActiveTenancy,
	hasActiveTenancyForRoom
} from '$lib/server/tenancies/service';
import { isTenancyServiceError, toTenancyErrorBody } from '$lib/server/tenancies/state';

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const landlordId = url.searchParams.get('landlordId');
		const tenantId = url.searchParams.get('tenantId');

		let condition;
		if (locals.session?.role === 'LANDLORD') {
			const ownScope = inArray(
				contracts.roomId,
				db
					.select({ id: rooms.id })
					.from(rooms)
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(eq(properties.landlordId, locals.session.landlordProfileId!))
			);
			// Cho phép lọc theo 1 khách (dùng trong tenant detail) nhưng vẫn trong phạm vi chủ trọ
			condition = tenantId ? and(ownScope, eq(contracts.tenantId, tenantId)) : ownScope;
		} else if (locals.session?.role === 'TENANT') {
			condition = eq(contracts.tenantId, locals.session.tenantProfileId!);
		} else if (landlordId) {
			condition = inArray(
				contracts.roomId,
				db
					.select({ id: rooms.id })
					.from(rooms)
					.innerJoin(properties, eq(rooms.propertyId, properties.id))
					.where(eq(properties.landlordId, landlordId))
			);
		} else if (tenantId) {
			condition = eq(contracts.tenantId, tenantId);
		} else {
			return json({ error: 'Missing landlordId or tenantId' }, { status: 400 });
		}

		const result = await db.query.contracts.findMany({
			where: condition,
			with: {
				tenant: { with: { user: { columns: { name: true, phone: true } } } },
				paymentAccount: true,
				room: {
					with: { property: { columns: { name: true, shortName: true } }, paymentAccount: true }
				}
			},
			orderBy: desc(contracts.createdAt)
		});

		return json(result.map(toContractDto));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

/**
 * Chọn tài khoản nhận tiền cho hợp đồng: ưu tiên body, rồi tới tài khoản của phòng, rồi
 * mặc định của chủ trọ. Truy vấn phòng luôn scope theo landlord nên phòng của chủ khác
 * không lộ dữ liệu — service tenancy vẫn là nơi trả 404.
 */
async function resolveRoomPaymentAccount(
	landlordId: string,
	roomId: unknown,
	requestedPaymentAccountId: unknown
): Promise<{ paymentAccountId: string } | { response: Response }> {
	try {
		const scopedRoom =
			typeof roomId === 'string' && roomId
				? (
						await db
							.select({ paymentAccountId: rooms.paymentAccountId })
							.from(rooms)
							.innerJoin(properties, eq(rooms.propertyId, properties.id))
							.where(and(eq(rooms.id, roomId), eq(properties.landlordId, landlordId)))
							.limit(1)
					)[0]
				: undefined;

		const account = await getPaymentAccountForLandlord(
			landlordId,
			(typeof requestedPaymentAccountId === 'string' && requestedPaymentAccountId
				? requestedPaymentAccountId
				: scopedRoom?.paymentAccountId) || null
		);
		if (!account.isActive) {
			return { response: json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 }) };
		}
		return { paymentAccountId: account.id };
	} catch (error) {
		return { response: json({ error: errorMessage(error) }, { status: 400 }) };
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		// AUTH-006 — actor lấy từ locals.actor; landlordId KHÔNG bao giờ đọc từ body/query.
		if (!locals.actor) {
			return authorizationErrorToResponse(unauthenticatedError());
		}
		const actorResult = requireLandlordActor(locals.actor);
		if (!actorResult.ok) return authorizationErrorToResponse(actorResult.error);
		const actor = actorResult.value;
		const auth = { ok: true as const, value: actor.landlordId };

		const body = await request.json();
		const {
			tenantId,
			roomId,
			startDate,
			endDate,
			monthlyRent,
			deposit,
			fileUrl,
			notes,
			paymentAccountId
		} = body ?? {};

		// AUTH-006 — khi flag bật, contract PHẢI gắn lần thuê đang hiệu lực của phòng.
		// Lookup tenancy + insert nằm trong cùng transaction có lock để không race checkout;
		// tenancyId/managedTenantId/tenantId legacy đều derive từ DB, không tin body.
		if (isTenancyDualWriteEnabled()) {
			try {
				const roomPaymentAccount = await resolveRoomPaymentAccount(
					actor.landlordId,
					roomId,
					paymentAccountId
				);
				if ('response' in roomPaymentAccount) return roomPaymentAccount.response;

				const contract = await createContractForActiveTenancy(db, actor, {
					roomId,
					startDate,
					endDate,
					monthlyRent,
					deposit,
					fileUrl,
					notes,
					paymentAccountId: roomPaymentAccount.paymentAccountId,
					// Chỉ để đối chiếu — lệch với người thuê thật thì service từ chối.
					expectedLegacyTenantProfileId: tenantId ?? null
				});
				return json(contract, { status: 201 });
			} catch (error) {
				if (isTenancyServiceError(error)) {
					return json(toTenancyErrorBody(error, locals.requestId), { status: error.status });
				}
				throw error;
			}
		}

		// Luồng legacy (flag off) — giữ nguyên đến khi bật dual-write.
		if (!tenantId || !roomId || !startDate || !endDate || monthlyRent === undefined) {
			return json({ error: 'Thiếu thông tin hợp đồng bắt buộc' }, { status: 400 });
		}
		if (
			!(await landlordOwnsRoom(auth.value, roomId)) ||
			!(await landlordOwnsTenant(auth.value, tenantId))
		) {
			return forbidden();
		}

		// AUTH-006 rollback guard — flag đã tắt nhưng phòng vẫn có Tenancy ACTIVE do lần bật
		// trước. Không được insert contract mồ côi (tenancyId null) song song lịch sử canonical:
		// đi tiếp qua service để hợp đồng gắn đúng lần thuê, hoặc từ chối rõ ràng.
		if (await hasActiveTenancyForRoom(db, roomId)) {
			try {
				const roomPaymentAccount = await resolveRoomPaymentAccount(
					actor.landlordId,
					roomId,
					paymentAccountId
				);
				if ('response' in roomPaymentAccount) return roomPaymentAccount.response;

				const contract = await createContractForActiveTenancy(db, actor, {
					roomId,
					startDate,
					endDate,
					monthlyRent,
					deposit,
					fileUrl,
					notes,
					paymentAccountId: roomPaymentAccount.paymentAccountId,
					expectedLegacyTenantProfileId: tenantId
				});
				return json(contract, { status: 201 });
			} catch (error) {
				if (isTenancyServiceError(error)) {
					return json(toTenancyErrorBody(error, locals.requestId), { status: error.status });
				}
				throw error;
			}
		}

		const room = await db.query.rooms.findFirst({
			where: eq(rooms.id, roomId),
			columns: { paymentAccountId: true }
		});
		const selectedPaymentAccount = await getPaymentAccountForLandlord(
			auth.value,
			paymentAccountId || room?.paymentAccountId || null
		);
		if (!selectedPaymentAccount.isActive) {
			return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
		}

		const created = await db
			.insert(contracts)
			.values({
				tenantId,
				roomId,
				startDate,
				endDate,
				monthlyRent: Number(monthlyRent),
				deposit: deposit !== undefined ? Number(deposit) : 0,
				fileUrl: fileUrl || null,
				paymentAccountId: selectedPaymentAccount.id,
				notes: notes || null,
				status: 'active'
			})
			.returning();

		return json(toContractDto(created[0]));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const {
			id,
			startDate,
			endDate,
			monthlyRent,
			deposit,
			fileUrl,
			notes,
			status,
			paymentAccountId
		} = body;

		if (!id) {
			return json({ error: 'Missing contract ID' }, { status: 400 });
		}
		if (!(await landlordOwnsContract(auth.value, id))) {
			return forbidden();
		}

		const updateData: Record<string, unknown> = {};
		if (startDate !== undefined) updateData.startDate = startDate;
		if (endDate !== undefined) updateData.endDate = endDate;
		if (monthlyRent !== undefined) updateData.monthlyRent = Number(monthlyRent);
		if (deposit !== undefined) updateData.deposit = Number(deposit);
		if (fileUrl !== undefined) updateData.fileUrl = fileUrl;
		if (notes !== undefined) updateData.notes = notes;
		if (status !== undefined) updateData.status = status; // 'active' | 'expired' | 'terminated'
		if (paymentAccountId !== undefined) {
			const selectedPaymentAccount = await getPaymentAccountForLandlord(
				auth.value,
				paymentAccountId || null
			);
			if (!selectedPaymentAccount.isActive) {
				return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
			}
			updateData.paymentAccountId = selectedPaymentAccount.id;
		}

		if (Object.keys(updateData).length === 0) {
			return json({ error: 'No fields to update' }, { status: 400 });
		}

		const updated = await db
			.update(contracts)
			.set(updateData)
			.where(eq(contracts.id, id))
			.returning();

		return json(toContractDto(updated[0]));
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const id = url.searchParams.get('id');

		if (!id) {
			return json({ error: 'Missing contract ID' }, { status: 400 });
		}
		if (!(await landlordOwnsContract(auth.value, id))) {
			return forbidden();
		}

		await db.delete(contracts).where(eq(contracts.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
