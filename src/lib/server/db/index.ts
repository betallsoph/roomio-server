import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { validateEnvOrExit } from '../env';
import * as schema from './schema';

const env = validateEnvOrExit();

export const pool = new Pool({ connectionString: env.databaseUrl });

export const db = drizzle(pool, { schema });
export type Db = typeof db;
