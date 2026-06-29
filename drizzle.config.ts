import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl?.startsWith('postgres')) {
	throw new Error('DATABASE_URL phải trỏ tới Postgres trước khi chạy drizzle-kit.');
}

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: { url: databaseUrl }
});
