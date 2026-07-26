#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required for migration drift check}"

echo "Checking schema.ts matches committed migrations..."
probe_root="$(mktemp -d "./.roomio-migration-drift.XXXXXX")"
cleanup() {
	case "$probe_root" in
		./.roomio-migration-drift.*) rm -rf -- "$probe_root" ;;
		*) echo "Refusing to clean unexpected migration probe path: $probe_root" >&2 ;;
	esac
}
trap cleanup EXIT

cp -R drizzle "$probe_root/drizzle"
DRIZZLE_OUT="$probe_root/drizzle" \
	node node_modules/drizzle-kit/bin.cjs generate --name ci-schema-drift-probe

if ! diff -qr drizzle "$probe_root/drizzle" >/dev/null; then
	echo "Migration drift detected: schema.ts differs from committed migrations."
	echo "Run 'npm run db:generate' and commit the new migration."
	diff -qr drizzle "$probe_root/drizzle" || true
	exit 1
fi

echo "Checking migration journal integrity..."
node node_modules/drizzle-kit/bin.cjs check

echo "Migration checks passed."
