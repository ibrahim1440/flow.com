#!/usr/bin/env bash
# LOCAL migration rehearsal on main's exact schema and seed data (no Neon, no production):
#   1. a worktree of main (fc64c05 — the production baseline) builds a fresh disposable database
#      erp_finance_rehearsal with main's own migrations, then main's own seed (synthetic data);
#   2. every pre-existing table is fingerprinted (row count + md5 of its rows in primary-key order);
#   3. the branch's twelve accounting migrations are applied with prisma migrate deploy, timed;
#   4. the fingerprints are recomputed for the same tables and same columns: they must be unchanged
#      (the migrations may add tables and nullable columns, never change existing data);
#   5. the database is dropped.
# This proves the migrations apply cleanly on production's schema shape with representative data. It
# does NOT replace the rehearsal on a copy of production (real data volume, PostgreSQL 17, Neon).
#   bash scripts/accounting/local-migration-rehearsal.sh <outDir>
set -uo pipefail
OUT=${1:?out dir}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
REPO=$(cd "$(dirname "$0")/../.." && pwd); cd "$REPO"
set -a; . ./.env; set +a
case "$DATABASE_URL" in *@127.0.0.1:54329/*|*@localhost:54329/*) ;; *) echo "Refusing: DATABASE_URL is not the local server"; exit 2;; esac
BASE=${BASE_COMMIT:-fc64c05c1ef4e607365e0e0c5d7c32482ed2e26e}
DB=erp_finance_rehearsal
ADMIN=$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#'); URL=$(echo "$DATABASE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$DB\1#")
LOG="$OUT/rehearsal.txt"; : > "$LOG"; say() { echo "$*" | tee -a "$LOG"; }
# Random six-digit PINs for main's seed users (this run only; never printed).
pin() { printf "%06d" $(( $(od -An -N4 -tu4 /dev/urandom) % 1000000 )); }
WT="$OUT/main-worktree"; rm -rf "$WT"; git worktree prune
git worktree add -q --detach "$WT" "$BASE" || { say "worktree failed"; exit 1; }
ln -s "$REPO/node_modules" "$WT/node_modules"
trap 'git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1; psql "$ADMIN" -qAt -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1' EXIT
say "baseline: main $BASE; branch: $(git rev-parse HEAD); started $(date -u +%FT%TZ)"
psql "$ADMIN" -qAt -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" -c "COMMENT ON DATABASE $DB IS 'hiqbah-finance-disposable'" > /dev/null
( cd "$WT" && DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma migrate deploy ) > "$OUT/main-migrate.log" 2>&1 || { say "main migrations failed"; exit 1; }
( cd "$WT" && DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma generate >/dev/null 2>&1 && DATABASE_URL="$URL" ERP_SEED_ENABLED=true SEED_PIN_ADMIN=$(pin) SEED_PIN_DISPATCH=$(pin) SEED_PIN_INVENTORY=$(pin) SEED_PIN_QC=$(pin) SEED_PIN_ROASTING=$(pin) npx tsx prisma/seed.ts ) > "$OUT/main-seed.log" 2>&1 || { say "main seed failed (see main-seed.log)"; exit 1; }
say "main schema: $(psql "$URL" -qAt -c 'select count(*) from _prisma_migrations') migrations applied; seeded"
# Fingerprint every table that exists before the branch migrations, over the columns that exist now.
psql "$URL" -qAt -c "select relname || '|' || (select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid = c.oid and attnum > 0 and not attisdropped) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and relname <> '_prisma_migrations' order by relname" > "$OUT/tables-before.txt"
fingerprint() { while IFS='|' read -r t cols; do psql "$URL" -qAt -c "select '$t ' || count(*) || ':' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from (select $(echo "$cols" | sed 's/[^,]*/"&"/g') from \"$t\") x"; done < "$OUT/tables-before.txt"; }
fingerprint > "$OUT/fingerprint-before.txt"
say "fingerprinted $(wc -l < "$OUT/tables-before.txt") pre-existing tables ($(awk '{split($2,a,":"); s+=a[1]} END {print s}' "$OUT/fingerprint-before.txt") rows)"
t0=$(date +%s.%N)
DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma migrate deploy > "$OUT/branch-migrate.log" 2>&1; rc=$?
t1=$(date +%s.%N)
[ $rc -eq 0 ] || { say "branch migrations FAILED (see branch-migrate.log)"; exit 1; }
say "branch migrations applied: $(grep -c 'Applying migration' "$OUT/branch-migrate.log") in $(printf '%.1f' "$(echo "$t1 - $t0" | bc)") s; now $(psql "$URL" -qAt -c 'select count(*) from _prisma_migrations') in _prisma_migrations"
grep 'Applying migration' "$OUT/branch-migrate.log" | sed 's/^/  /' | tee -a "$LOG" > /dev/null
fingerprint > "$OUT/fingerprint-after.txt"
if diff -q "$OUT/fingerprint-before.txt" "$OUT/fingerprint-after.txt" > /dev/null; then say "pre-existing data: UNCHANGED (all $(wc -l < "$OUT/fingerprint-before.txt") tables identical over their original columns)"; res=0
else say "pre-existing data: CHANGED"; diff "$OUT/fingerprint-before.txt" "$OUT/fingerprint-after.txt" | head -20 | tee -a "$LOG"; res=1; fi
say "new tables: $(psql "$URL" -qAt -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'") total; triggers: $(psql "$URL" -qAt -c 'select count(*) from pg_trigger where not tgisinternal')"
say "result: $([ $res -eq 0 ] && echo PASS || echo FAIL); finished $(date -u +%FT%TZ)"
sed -i -E 's#postgres(ql)?://[^ "]+#postgres://***#g' "$OUT"/*.log "$LOG"
exit $res
