#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required for migration drift check}"

echo "Checking schema.ts matches committed migrations..."
node node_modules/drizzle-kit/bin.cjs generate --name ci-schema-drift-probe

if [[ -n "$(git status --porcelain drizzle/)" ]]; then
	echo "Migration drift detected: schema.ts differs from committed migrations."
	echo "Run 'npm run db:generate' and commit the new migration."
	git status --porcelain drizzle/
	git checkout -- drizzle/
	exit 1
fi

echo "Checking migration journal integrity..."
node node_modules/drizzle-kit/bin.cjs check

echo "Migration checks passed."
