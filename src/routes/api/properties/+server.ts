import { json } from '@sveltejs/kit';
import { errorMessage } from '$lib/server/api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { properties, blocks } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { forbidden, landlordOwnsProperty, requireLandlord } from '$lib/server/authz';

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;

		// Backward-compatible query param is ignored; session is the source of truth.
		void url;

		const result = await db.query.properties.findMany({
			where: eq(properties.landlordId, landlordId),
			with: {
				blocks: true,
				rooms: {
					columns: { id: true, roomNumber: true, status: true, roomType: true, monthlyRent: true }
				}
			},
			orderBy: asc(properties.name)
		});

		return json(result);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;
		const landlordId = auth.value;

		const body = await request.json();
		const { name, shortName, address, blocks: blockNames } = body;

		if (!landlordId || !name || !shortName || !address) {
			return json({ error: 'Missing required property fields' }, { status: 400 });
		}

		const property = await db.transaction(async (tx) => {
			// Create property
			const prop = (
				await tx.insert(properties).values({ landlordId, name, shortName, address }).returning()
			)[0];

			// Create initial blocks if specified
			if (blockNames && Array.isArray(blockNames)) {
				const values = blockNames
					.map((blockName: string) => blockName.trim())
					.filter((blockName: string) => blockName)
					.map((blockName: string) => ({ propertyId: prop.id, name: blockName }));

				if (values.length > 0) {
					await tx.insert(blocks).values(values);
				}
			}

			return prop;
		});

		const fullProperty = await db.query.properties.findFirst({
			where: eq(properties.id, property.id),
			with: {
				blocks: true,
				rooms: true
			}
		});

		return json(fullProperty);
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const auth = requireLandlord(locals.session);
		if (!auth.ok) return auth.response;

		const body = await request.json();
		const { id, name, shortName, address, blocks: blockNames } = body;

		if (!id) {
			return json({ error: 'Missing property ID' }, { status: 400 });
		}
		if (!(await landlordOwnsProperty(auth.value, id))) {
			return forbidden();
		}

		await db.transaction(async (tx) => {
			// Update property details
			const updateData: Record<string, unknown> = {};
			if (name !== undefined) updateData.name = name;
			if (shortName !== undefined) updateData.shortName = shortName;
			if (address !== undefined) updateData.address = address;

			if (Object.keys(updateData).length > 0) {
				await tx.update(properties).set(updateData).where(eq(properties.id, id));
			}

			// Synchronize blocks (add new ones, keep existing ones)
			if (blockNames && Array.isArray(blockNames)) {
				const existingBlocks = await tx.select().from(blocks).where(eq(blocks.propertyId, id));
				const existingNames = existingBlocks.map((b) => b.name);

				const newBlocks = blockNames
					.map((blockName: string) => blockName.trim())
					.filter((blockName: string) => blockName && !existingNames.includes(blockName))
					.map((blockName: string) => ({ propertyId: id, name: blockName }));

				if (newBlocks.length > 0) {
					await tx.insert(blocks).values(newBlocks);
				}
			}
		});

		const fullProperty = await db.query.properties.findFirst({
			where: eq(properties.id, id),
			with: {
				blocks: true,
				rooms: true
			}
		});

		return json(fullProperty);
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
			return json({ error: 'Missing property ID' }, { status: 400 });
		}
		if (!(await landlordOwnsProperty(auth.value, id))) {
			return forbidden();
		}

		await db.delete(properties).where(eq(properties.id, id));

		return json({ success: true });
	} catch (error) {
		return json({ error: errorMessage(error) }, { status: 500 });
	}
};
