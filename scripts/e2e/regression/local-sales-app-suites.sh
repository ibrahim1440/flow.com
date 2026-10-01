#!/usr/bin/env bash
# Runs the Sales running-app suites (sales-security, sales-workflow) LOCALLY, against a fresh
# disposable `sales_preview` database on the local PostgreSQL server (127.0.0.1:54329).
#
#   bash scripts/e2e/regression/local-sales-app-suites.sh <outDir>
#
# Safety: refuses any non-local server; the database is dropped and recreated here and carries the
# disposable marker; the app and the suites connect as `sales_preview_app` (DML only, owns nothing,
# no DDL, member of no role) — the same shape the suites' own guard expects. JWT, PIN-lookup and
# rate-limit secrets and the role password are generated fresh for the run and never printed.
# The sandbox collection source is enabled (SALES_SANDBOX_COLLECTIONS=true), as on the disposable
# Sales preview; its production-host denylist stays in force (the database here is local).
# Needs: `.env` with DATABASE_URL = the local server's owner URL; a production build (`npm run build`).
set -euo pipefail
OUT=${1:?out dir}; mkdir -p "$OUT"
cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a
case "$DATABASE_URL" in *@127.0.0.1:54329/*|*@localhost:54329/*) ;; *) echo "Refusing: DATABASE_URL is not the local server"; exit 2;; esac
ADMIN=$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')
SPDB=$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/sales_preview#')
APPPW=$(openssl rand -hex 16)
psql "$ADMIN" -qAt -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS sales_preview WITH (FORCE)" -c "CREATE DATABASE sales_preview" \
  -c "COMMENT ON DATABASE sales_preview IS 'hiqbah-finance-disposable'" > /dev/null
( DATABASE_URL="$SPDB" DIRECT_URL="$SPDB" npx prisma migrate deploy ) > "$OUT/sales-app-migrate.log" 2>&1
psql "$SPDB" -qAt -v ON_ERROR_STOP=1 > /dev/null <<SQL
DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_preview_app') THEN CREATE ROLE sales_preview_app LOGIN; END IF; END \$\$;
ALTER ROLE sales_preview_app PASSWORD '$APPPW';
GRANT CONNECT ON DATABASE sales_preview TO sales_preview_app;
GRANT USAGE ON SCHEMA public TO sales_preview_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sales_preview_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sales_preview_app;
SQL
SPAPP=$(echo "$SPDB" | sed -E "s#//[^:]+:[^@]+@#//sales_preview_app:$APPPW@#")
JWT=$(openssl rand -base64 32); PINS=$(openssl rand -base64 32); RLS=$(openssl rand -base64 32)
PORT=3020
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production DATABASE_URL="$SPAPP" DIRECT_URL="$SPAPP" \
  JWT_SECRET="$JWT" PIN_LOOKUP_SECRET="$PINS" RATE_LIMIT_SECRET="$RLS" SALES_SANDBOX_COLLECTIONS=true \
  node node_modules/next/dist/bin/next start -p $PORT > "$OUT/sales-app-server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/login" && break; sleep 1; done
echo "server as $(psql "$SPAPP" -qAt -c 'select current_user') on :$PORT"
rc=0
for s in sales-security sales-workflow; do
  env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$SPAPP" PIN_LOOKUP_SECRET="$PINS" SALES_TEST_BASE_URL="http://127.0.0.1:$PORT" \
    node scripts/e2e/regression/$s.mjs > "$OUT/$s.log" 2>&1 || rc=1
  echo "$s: $(grep -E '[0-9]+ passed, [0-9]+ failed' "$OUT/$s.log" | tail -1)"
done
# Nothing secret goes to disk: mask connection strings in the logs.
for f in "$OUT"/sales-*.log; do sed -i -E 's#postgres(ql)?://[^ "]+#postgres://***#g' "$f"; done
exit $rc
