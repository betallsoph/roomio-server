import { drizzle } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as schema from './schema';

// Production: đặt DATABASE_URL = postgres://user:pass@host:5432/dbname
// Dev/local: bỏ trống DATABASE_URL — dùng PGlite (Postgres nhúng, lưu vào thư mục ./pgdata,
// không cần cài Postgres server)

const databaseUrl = process.env.DATABASE_URL;

function createDb() {
	if (databaseUrl && databaseUrl.startsWith('postgres')) {
		return drizzle(databaseUrl, { schema });
	}
	return drizzlePglite(process.env.PGLITE_DIR ?? './pgdata', { schema });
}

export const db = createDb();
export type Db = typeof db;
