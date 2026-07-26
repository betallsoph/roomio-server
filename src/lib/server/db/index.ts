import { drizzle } from 'drizzle-orm/node-postgres';
import { validateEnvOrExit } from '../env';
import * as schema from './schema';

const env = validateEnvOrExit();

export const db = drizzle(env.databaseUrl, { schema });
export type Db = typeof db;
