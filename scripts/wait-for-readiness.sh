#!/usr/bin/env sh
set -eu

URL="${1:-http://127.0.0.1:3000/api/health/ready}"
MAX_ATTEMPTS="${2:-30}"
SLEEP_SEC="${3:-2}"

probe() {
	node -e "fetch(process.argv[1], { signal: AbortSignal.timeout(3000) }).then(async (r) => { await r.arrayBuffer(); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))" "$1"
}

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
	if probe "$URL"; then
		echo "API is ready (attempt ${attempt})"
		exit 0
	fi
	sleep "$SLEEP_SEC"
	attempt=$((attempt + 1))
done

echo "ERROR: API readiness check failed after ${MAX_ATTEMPTS} attempts" >&2
exit 1
