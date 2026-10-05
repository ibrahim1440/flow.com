#!/usr/bin/env bash
# Six-document e-invoice matrix from the application on a fresh local disposable database
# (erp_finance_zatca: dropped, recreated with the disposable marker, migrated), for validation with
# ZATCA's official SDK (scripts/accounting/zatca-sdk-validate.sh). Synthetic data; nothing is sent.
#
#   bash scripts/accounting/zatca-matrix.sh <outDir>
set -euo pipefail
OUT=${1:?out dir}; mkdir -p "$OUT"
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
case "$DATABASE_URL" in *@127.0.0.1:54329/*|*@localhost:54329/*) ;; *) echo "Refusing: DATABASE_URL is not the local server"; exit 2;; esac
DB=erp_finance_zatca
ADMIN=$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')
OWNER=$(echo "$DATABASE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$DB\1#")
psql "$ADMIN" -qAt -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" \
  -c "COMMENT ON DATABASE $DB IS 'hiqbah-finance-disposable'" > /dev/null 2>&1
( DATABASE_URL="$OWNER" DIRECT_URL="$OWNER" npx prisma migrate deploy ) > "$OUT/migrate.log" 2>&1
sed -i -E 's#postgres(ql)?://[^ "]+#postgres://***#g' "$OUT/migrate.log"
FIN_DISPOSABLE_DB=$DB DATABASE_URL="$OWNER" DIRECT_URL="$OWNER" npx tsx scripts/accounting/zatca-matrix.ts "$OUT"
