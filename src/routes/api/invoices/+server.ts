import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { invoices, invoiceItems, rooms, contracts } from '$lib/server/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { requireLandlordActor, requireTenantActor } from '$lib/server/authorization/actor';
import {
	authorizationErrorToResponse,
	isAuthorizationError,
	wrongRoleError
} from '$lib/server/authorization/errors';
import { guardOperationalUserActor } from '$lib/server/authorization/policies';
import { findRoomForLandlord } from '$lib/server/authorization/scoped-queries';
import { toInvoiceDto } from '$lib/server/dto/invoice';
import { getPaymentAccountForLandlord } from '$lib/server/payment-accounts';
import {
	assertInvoicesOwnedByLandlord,
	assertPaymentAccountForLandlordRoom,
	listInvoicesForLandlord,
	listInvoicesForTenant,
	mapFinanceScopeError,
	resolveActiveTenancySnapshotForRoom
} from '$lib/server/operations/finance-scope';
import { isOperationsError } from '$lib/server/operations/errors';

function mapHandlerError(error: unknown) {
	const mapped = mapFinanceScopeError(error);
	if (mapped) {
		return json({ error: mapped.message }, { status: mapped.status });
	}
	if (isAuthorizationError(error)) {
		return authorizationErrorToResponse(error);
	}
	if (isOperationsError(error)) {
		return json({ error: error.message }, { status: error.status });
	}
	return json({ error: errorMessage(error) }, { status: 500 });
}

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;

		const status = url.searchParams.get('status');
		const roomId = url.searchParams.get('roomId');
		const tenantProfileId = url.searchParams.get('tenantId');

		const landlord = requireLandlordActor(guard.actor);
		if (landlord.ok) {
			const result = await listInvoicesForLandlord(db, landlord.value, {
				status,
				roomId,
				tenantProfileId
			});
			return json(result.map(toInvoiceDto));
		}

		const tenant = requireTenantActor(guard.actor);
		if (tenant.ok) {
			const result = await listInvoicesForTenant(db, tenant.value);
			return json(result.map(toInvoiceDto));
		}

		return authorizationErrorToResponse(wrongRoleError('Không có quyền truy cập dữ liệu này'));
	} catch (error) {
		return mapHandlerError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;
		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(landlord.error);
		}
		const actor = landlord.value;

		const body = await request.json();
		const { roomId, month, rentAmount, dueDate, items, notes, paymentAccountId } = body;

		if (
			!roomId ||
			!month ||
			rentAmount === undefined ||
			!dueDate ||
			!items ||
			!Array.isArray(items)
		) {
			return json({ error: 'Missing required invoice parameters' }, { status: 400 });
		}

		await findRoomForLandlord(db, actor, roomId);

		const existingInvoice = await db.query.invoices.findFirst({
			where: and(eq(invoices.roomId, roomId), eq(invoices.month, month)),
			columns: { id: true }
		});
		if (existingInvoice) {
			return json({ error: 'Phòng này đã có hóa đơn cho tháng đã chọn' }, { status: 409 });
		}

		const room = await db.query.rooms.findFirst({
			where: eq(rooms.id, roomId),
			with: {
				tenant: { with: { user: true } },
				paymentAccount: true
			}
		});

		if (!room) {
			return json({ error: 'Room not found' }, { status: 404 });
		}

		if (!room.tenant) {
			return json({ error: 'Room has no active tenant' }, { status: 400 });
		}

		const tenantName = room.tenant.user.name;
		const tenantPhone = room.tenant.user.phone ?? '';
		const activeContract = await db.query.contracts.findFirst({
			where: and(eq(contracts.roomId, roomId), eq(contracts.status, 'active')),
			columns: { paymentAccountId: true },
			orderBy: desc(contracts.createdAt)
		});
		const selectedPaymentAccount = await getPaymentAccountForLandlord(
			actor.landlordId,
			paymentAccountId || activeContract?.paymentAccountId || room.paymentAccountId || null
		);
		if (!selectedPaymentAccount.isActive) {
			return json({ error: 'Tài khoản nhận tiền đã tắt' }, { status: 400 });
		}
		await assertPaymentAccountForLandlordRoom(
			db,
			actor.landlordId,
			roomId,
			selectedPaymentAccount.id
		);

		const invoiceItemList: { name: string; amount: number; details?: string }[] = items;
		const totalAmount = invoiceItemList.reduce((sum, item) => sum + Number(item.amount), 0);

		const randomHex = Math.floor(1000 + Math.random() * 9000).toString();
		const invoiceId = `INV-${month.replace('-', '')}-${randomHex}`;

		const invoice = await db.transaction(async (tx) => {
			const tenancySnapshot = await resolveActiveTenancySnapshotForRoom(
				tx,
				actor.landlordId,
				roomId
			);

			const inv = (
				await tx
					.insert(invoices)
					.values({
						id: invoiceId,
						roomId,
						roomNumber: room.roomNumber,
						tenantName,
						tenantPhone,
						month,
						rentAmount: Number(rentAmount),
						totalAmount,
						dueDate,
						status: 'pending',
						paidAmount: 0,
						paymentAccountId: selectedPaymentAccount.id,
						createdAt: new Date().toISOString().split('T')[0],
						notes,
						managedTenantId: tenancySnapshot?.managedTenantId ?? null,
						tenancyId: tenancySnapshot?.tenancyId ?? null
					})
					.returning()
			)[0];

			await tx.insert(invoiceItems).values(
				invoiceItemList.map((item) => ({
					invoiceId: inv.id,
					name: item.name,
					amount: Number(item.amount),
					details: item.details
				}))
			);

			await tx
				.update(rooms)
				.set({
					status: 'debt',
					debtAmount: sql`coalesce(${rooms.debtAmount}, 0) + ${totalAmount}`
				})
				.where(eq(rooms.id, roomId));

			return inv;
		});

		const fullInvoice = await db.query.invoices.findFirst({
			where: eq(invoices.id, invoice.id),
			with: { items: true, paymentAccount: true }
		});

		return json(fullInvoice ? toInvoiceDto(fullInvoice) : null);
	} catch (error) {
		return mapHandlerError(error);
	}
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	try {
		const guard = guardOperationalUserActor(locals.actor);
		if (!guard.ok) return guard.response;
		const landlord = requireLandlordActor(guard.actor);
		if (!landlord.ok) {
			return authorizationErrorToResponse(landlord.error);
		}
		const actor = landlord.value;

		const body = await request.json();
		const ids: string[] = Array.isArray(body.ids)
			? body.ids.filter((id: unknown): id is string => typeof id === 'string')
			: [];
		if (ids.length === 0) {
			return json({ error: 'Chưa chọn hóa đơn để xóa' }, { status: 400 });
		}

		await assertInvoicesOwnedByLandlord(db, actor, ids);

		const ownedInvoices = await db.query.invoices.findMany({
			where: inArray(invoices.id, ids)
		});

		await db.transaction(async (tx) => {
			for (const invoice of ownedInvoices) {
				await tx.delete(invoices).where(eq(invoices.id, invoice.id));
				if (invoice.status !== 'paid' && invoice.status !== 'draft') {
					const outstanding = Math.max(invoice.totalAmount - invoice.paidAmount, 0);
					await tx
						.update(rooms)
						.set({
							debtAmount: sql`greatest(coalesce(${rooms.debtAmount}, 0) - ${outstanding}, 0)`
						})
						.where(eq(rooms.id, invoice.roomId));
				}
			}
		});

		return json({ success: true, count: ownedInvoices.length });
	} catch (error) {
		return mapHandlerError(error);
	}
};
