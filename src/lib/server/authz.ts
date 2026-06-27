import { json } from '@sveltejs/kit';
import type { SessionData } from '$lib/server/session';
import { db } from '$lib/server/db';
import { contracts, invoices, properties, rooms, tenantProfiles } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

export type AuthResult<T> = { ok: true; value: T } | { ok: false; response: Response };

export function requireLandlord(session: SessionData | null): AuthResult<string> {
	if (session?.role !== 'LANDLORD' || !session.landlordProfileId) {
		return {
			ok: false,
			response: json({ error: 'Chỉ chủ trọ được thực hiện thao tác này' }, { status: 403 })
		};
	}
	return { ok: true, value: session.landlordProfileId };
}

export function requireTenant(session: SessionData | null): AuthResult<string> {
	if (session?.role !== 'TENANT' || !session.tenantProfileId) {
		return {
			ok: false,
			response: json({ error: 'Chỉ khách thuê được thực hiện thao tác này' }, { status: 403 })
		};
	}
	return { ok: true, value: session.tenantProfileId };
}

export async function landlordOwnsProperty(
	landlordId: string,
	propertyId: string
): Promise<boolean> {
	const property = await db.query.properties.findFirst({
		where: and(eq(properties.id, propertyId), eq(properties.landlordId, landlordId)),
		columns: { id: true }
	});
	return !!property;
}

export async function landlordOwnsRoom(landlordId: string, roomId: string): Promise<boolean> {
	const row = await db
		.select({ id: rooms.id })
		.from(rooms)
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(rooms.id, roomId), eq(properties.landlordId, landlordId)))
		.limit(1);
	return row.length > 0;
}

export async function landlordOwnsTenant(landlordId: string, tenantId: string): Promise<boolean> {
	const row = await db
		.select({ id: tenantProfiles.id })
		.from(tenantProfiles)
		.innerJoin(rooms, eq(tenantProfiles.id, rooms.tenantId))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(tenantProfiles.id, tenantId), eq(properties.landlordId, landlordId)))
		.limit(1);
	return row.length > 0;
}

export async function landlordOwnsInvoice(landlordId: string, invoiceId: string): Promise<boolean> {
	const row = await db
		.select({ id: invoices.id })
		.from(invoices)
		.innerJoin(rooms, eq(invoices.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(invoices.id, invoiceId), eq(properties.landlordId, landlordId)))
		.limit(1);
	return row.length > 0;
}

export async function tenantOwnsInvoice(tenantId: string, invoiceId: string): Promise<boolean> {
	const row = await db
		.select({ id: invoices.id })
		.from(invoices)
		.innerJoin(rooms, eq(invoices.roomId, rooms.id))
		.where(and(eq(invoices.id, invoiceId), eq(rooms.tenantId, tenantId)))
		.limit(1);
	return row.length > 0;
}

export async function landlordOwnsContract(
	landlordId: string,
	contractId: string
): Promise<boolean> {
	const row = await db
		.select({ id: contracts.id })
		.from(contracts)
		.innerJoin(rooms, eq(contracts.roomId, rooms.id))
		.innerJoin(properties, eq(rooms.propertyId, properties.id))
		.where(and(eq(contracts.id, contractId), eq(properties.landlordId, landlordId)))
		.limit(1);
	return row.length > 0;
}

export function forbidden(message = 'Không có quyền truy cập dữ liệu này') {
	return json({ error: message }, { status: 403 });
}
