import { drizzle } from 'drizzle-orm/node-postgres';
import { validateEnvOrExit } from '../env';
import { createPool, poolMaxForRole, startPoolMetrics, type ProcessRole } from './pool';
import * as schema from './schema';

const env = validateEnvOrExit();

/** Process này là API. Dispatcher (JOB-001/JOB-006) dùng cùng factory với role riêng. */
export const PROCESS_ROLE: ProcessRole = 'api';

// Một process = đúng một pool, dựng từ module dùng chung này với config đã kiểm tra.
export const pool = createPool(env, PROCESS_ROLE);

/** Dừng lấy mẫu metric; dùng khi graceful shutdown hoặc trong test. */
export const stopPoolMetrics = startPoolMetrics(pool, PROCESS_ROLE, {
	max: poolMaxForRole(env.db, PROCESS_ROLE)
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
