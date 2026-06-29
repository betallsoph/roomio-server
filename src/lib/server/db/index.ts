import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const databaseUrl = process.env.DATABASE_URL;

function createDb() {
	if (!databaseUrl?.startsWith('postgres')) {
		throw new Error(
			'DATABASE_URL phải trỏ tới Postgres. Ví dụ: postgres://roomio:pass@localhost:5432/roomio'
		);
	}

	return drizzle(databaseUrl, { schema });
}

export const db = createDb();
export type Db = typeof db;
