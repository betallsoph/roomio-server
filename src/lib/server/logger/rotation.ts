/**
 * Safe defaults for log rotation on A1-APP.
 * Application writes JSON lines to stdout; the host (logrotate or container driver)
 * enforces retention so logs cannot fill the disk.
 *
 * These values are documentation defaults — wire them in server logrotate or
 * Docker logging options during deploy (OBS-003 / ops runbook).
 */
export const LOG_ROTATION_DEFAULTS = {
	/** Max size per rotated file before compression. */
	maxFileSizeMb: 50,
	/** Number of rotated files to keep per service. */
	rotatedFilesToKeep: 14,
	/** Delete archives older than this many days. */
	retentionDays: 30,
	/** Compress rotated files to save disk. */
	compressRotated: true,
	/** Warn ops when log volume usage exceeds this percent of mount. */
	diskUsageWarnPercent: 80
} as const;

export const LOG_ROTATE_CONFIG_SNIPPET = `# /etc/logrotate.d/roomio-api — defaults from OBS-001
/var/log/roomio/api.log {
    daily
    rotate ${LOG_ROTATION_DEFAULTS.rotatedFilesToKeep}
    maxsize ${LOG_ROTATION_DEFAULTS.maxFileSizeMb}M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
`;
