import { Pool, type PoolConfig } from 'pg';
import type { DbPoolConfig, EnvConfig } from '../env';
import { getLogger } from '../logger/index.js';

// INFRA-005 — pool và timeout tường minh.
//
// Không dùng mặc định của thư viện: pg mặc định max=10 và KHÔNG có statement/lock/
// idle-in-transaction timeout, nghĩa là một query treo có thể giữ connection vô hạn và
// một máy A1 một OCPU dễ vượt ngân sách connection. Module này dựng config từ env đã
// kiểm tra, gắn application_name theo process role + release, và xuất metric hàng đợi.

export type ProcessRole = 'api' | 'dispatcher';

/** Postgres cắt application_name ở NAMEDATALEN-1 = 63 byte. */
const APPLICATION_NAME_MAX_LENGTH = 63;

/** Chu kỳ lấy metric pool; spec cho phép 15–30 giây. */
export const POOL_METRICS_INTERVAL_MS = 30_000;

/** Thông điệp pg-pool ném ra khi hết hạn chờ connection. */
const POOL_CONNECTION_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

export interface PoolMetrics {
	event: 'db_pool_metrics';
	processRole: ProcessRole;
	/** Connection đang mở (đang dùng + rảnh). */
	totalCount: number;
	/** Connection rảnh trong pool. */
	idleCount: number;
	/** Request đang XẾP HÀNG chờ connection — lớn hơn 0 kéo dài nghĩa là pool thiếu. */
	waitingCount: number;
	max: number;
}

export interface ScrubbedPoolError {
	event: 'db_pool_error';
	processRole: ProcessRole;
	/** Mã lỗi Postgres (ví dụ 57P01) hoặc mã lỗi hệ thống; không kèm chi tiết kết nối. */
	code: string;
	errorName: string;
}

export function poolMaxForRole(db: DbPoolConfig, role: ProcessRole): number {
	return role === 'api' ? db.apiPoolMax : db.dispatcherPoolMax;
}

/** `roomio-api:<sha ngắn>` — để `pg_stat_activity` chỉ đúng process và release. */
export function buildApplicationName(role: ProcessRole, releaseSha: string): string {
	const shortSha = (releaseSha || 'unknown').trim().slice(0, 7) || 'unknown';
	return `roomio-${role}:${shortSha}`.slice(0, APPLICATION_NAME_MAX_LENGTH);
}

/**
 * Dựng `PoolConfig` cho một process role. Hàm thuần: không mở connection,
 * không đọc `process.env`, nên test cấu hình được mà không cần PostgreSQL.
 */
export function buildPoolConfig(env: EnvConfig, role: ProcessRole): PoolConfig {
	const { db } = env;
	return {
		connectionString: env.databaseUrl,
		max: poolMaxForRole(db, role),
		// Chờ connection có giới hạn: request thừa fail nhanh thay vì treo hàng đợi.
		connectionTimeoutMillis: db.connectionTimeoutMs,
		idleTimeoutMillis: db.idleTimeoutMs,
		// Ba timeout dưới đây đi trong startup packet nên áp cho MỌI session của pool.
		statement_timeout: db.statementTimeoutMs,
		lock_timeout: db.lockTimeoutMs,
		idle_in_transaction_session_timeout: db.idleInTransactionTimeoutMs,
		application_name: buildApplicationName(role, env.releaseSha)
	};
}

/** Tổng connection tối đa mọi process có thể mở cùng lúc. */
export function totalConfiguredConnections(db: DbPoolConfig): number {
	return db.apiPoolMax + db.dispatcherPoolMax;
}

/** Phân biệt lỗi hết hạn chờ pool với lỗi nghiệp vụ, để API trả mã an toàn đúng loại. */
export function isPoolConnectionTimeout(error: unknown): boolean {
	return error instanceof Error && error.message.includes(POOL_CONNECTION_TIMEOUT_MESSAGE);
}

/**
 * Chỉ giữ trường an toàn. `error.message` của pg có thể chứa host/database/tên role
 * nên không bao giờ được log nguyên văn.
 */
export function scrubPoolError(error: unknown, processRole: ProcessRole): ScrubbedPoolError {
	const code =
		typeof error === 'object' && error !== null && 'code' in error
			? String((error as { code: unknown }).code ?? 'UNKNOWN')
			: 'UNKNOWN';
	return {
		event: 'db_pool_error',
		processRole,
		code: code || 'UNKNOWN',
		errorName: error instanceof Error ? error.name : 'UnknownError'
	};
}

/**
 * Sink lỗi mặc định: cũng đi qua Pino logger chung. Nhận payload ĐÃ scrub nên
 * `error.message` (có thể chứa host/role/database) không bao giờ được ghi.
 */
function defaultErrorSink(scrubbed: ScrubbedPoolError): void {
	getLogger().error(scrubbed, 'db pool error');
}

type MetricsSource = Pick<Pool, 'totalCount' | 'idleCount' | 'waitingCount'>;

export function collectPoolMetrics(
	pool: MetricsSource,
	processRole: ProcessRole,
	max: number
): PoolMetrics {
	return {
		event: 'db_pool_metrics',
		processRole,
		totalCount: pool.totalCount,
		idleCount: pool.idleCount,
		waitingCount: pool.waitingCount,
		max
	};
}

export interface PoolMetricsOptions {
	intervalMs?: number;
	sink?: (metrics: PoolMetrics) => void;
	max: number;
}

/**
 * Sink mặc định: Pino logger dùng chung của OBS-001 (một JSON object mỗi dòng, đã có
 * redaction/sanitize ở tầng logger). Chỉ đẩy field đã chọn — không có error, DB URL
 * hay credential nào đi qua đây.
 */
function defaultMetricsSink(metrics: PoolMetrics): void {
	getLogger().info(metrics, 'db pool metrics');
}

/**
 * Lấy mẫu metric theo chu kỳ. Timer được `unref()` nên KHÔNG giữ process sống —
 * `npm test` và graceful shutdown vẫn thoát bình thường.
 * Trả về hàm dừng để test/shutdown gọi.
 */
export function startPoolMetrics(
	pool: MetricsSource,
	role: ProcessRole,
	options: PoolMetricsOptions
): () => void {
	const intervalMs = options.intervalMs ?? POOL_METRICS_INTERVAL_MS;
	const sink = options.sink ?? defaultMetricsSink;

	const timer = setInterval(() => {
		sink(collectPoolMetrics(pool, role, options.max));
	}, intervalMs);

	// Không giữ event loop sống chỉ vì đang đo pool.
	timer.unref?.();

	return () => clearInterval(timer);
}

/** Tạo đúng một pool cho process hiện tại, đã gắn error handler đã scrub. */
export function createPool(
	env: EnvConfig,
	role: ProcessRole,
	errorSink: (error: ScrubbedPoolError) => void = defaultErrorSink
): Pool {
	const pool = new Pool(buildPoolConfig(env, role));

	// Lỗi của client rảnh trong pool là sự kiện async: không bắt thì process crash.
	// Chỉ đẩy payload ĐÃ scrub; `error` gốc không bao giờ tới logger.
	pool.on('error', (error) => {
		errorSink(scrubPoolError(error, role));
	});

	return pool;
}
