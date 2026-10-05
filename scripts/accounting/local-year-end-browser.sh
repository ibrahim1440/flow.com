#!/usr/bin/env bash
# Browser year-end close on an ISOLATED local database (erp_finance_yearend): dropped, recreated
# with the disposable marker, migrated, given the runtime role's DML grants, seeded with the
# synthetic prior-year scenario (scripts/accounting/seed-year-end-scenario.ts); then the app runs as
# the restricted runtime role accounting_app on :3041 and tests/accounting/visual/year-end-forms.mjs
# drives the real forms. Nothing touches erp_finance_dev or any other database.
#
#   bash scripts/accounting/local-year-end-browser.sh <shotsDir>
#
# Needs: `.env` with DATABASE_URL (local owner URL), ACC_RUNTIME_DATABASE_URL (local accounting_app
# URL) and FIN_FIXTURE_PASSWORD; a production build (`npm run build`). No URL or password is printed.
set -euo pipefail
OUT=${1:?shots dir}; mkdir -p "$OUT"
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
case "$DATABASE_URL" in *@127.0.0.1:54329/*|*@localhost:54329/*) ;; *) echo "Refusing: DATABASE_URL is not the local server"; exit 2;; esac
case "$ACC_RUNTIME_DATABASE_URL" in *@127.0.0.1:54329/*|*@localhost:54329/*) ;; *) echo "Refusing: ACC_RUNTIME_DATABASE_URL is not the local server"; exit 2;; esac
DB=erp_finance_yearend
PORT=3041
# Never test against a server this run did not start.
if curl -s -o /dev/null "http://127.0.0.1:$PORT/login"; then echo "port $PORT is already served by another process; stop it first"; exit 9; fi
swapdb() { echo "$1" | sed -E "s#/[^/?]+(\?.*)?\$#/$DB\1#"; }
ADMIN=$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')
OWNER=$(swapdb "$DATABASE_URL"); RUNTIME=$(swapdb "$ACC_RUNTIME_DATABASE_URL")
psql "$ADMIN" -qAt -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" \
  -c "COMMENT ON DATABASE $DB IS 'hiqbah-finance-disposable'" > /dev/null
( DATABASE_URL="$OWNER" DIRECT_URL="$OWNER" npx prisma migrate deploy ) > "$OUT/year-end-migrate.log" 2>&1
psql "$OWNER" -qAt -v ON_ERROR_STOP=1 -f scripts/accounting/runtime-grants.sql > /dev/null
FIN_DISPOSABLE_DB=$DB DATABASE_URL="$OWNER" DIRECT_URL="$OWNER" npx tsx scripts/accounting/seed-year-end-scenario.ts
env -u DIRECT_URL -u ACCOUNTING_PROVISIONAL_POSTING DATABASE_URL="$RUNTIME" node node_modules/next/dist/bin/next start -p $PORT > "$OUT/year-end-server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/login" && break; sleep 1; done
echo "server as $(psql "$RUNTIME" -qAt -c 'select current_user') on :$PORT, database $(psql "$RUNTIME" -qAt -c 'select current_database()')"
BASE_URL=http://localhost:$PORT FIN_PASSWORD="$FIN_FIXTURE_PASSWORD" RUNTIME_DATABASE_URL="$RUNTIME" PW_CHROMIUM=${PW_CHROMIUM:-/opt/pw-browsers/chromium} \
  node tests/accounting/visual/year-end-forms.mjs "$OUT"
