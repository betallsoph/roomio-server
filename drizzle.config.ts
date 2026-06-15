import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;

// Production: chạy migrate với DATABASE_URL trỏ tới Postgres thật.
// Dev/local: không có DATABASE_URL thì migrate vào PGlite (./pgdata).
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	...(databaseUrl && databaseUrl.startsWith('postgres')
		? { dbCredentials: { url: databaseUrl } }
		: { driver: 'pglite', dbCredentials: { url: './pgdata' } })
});
