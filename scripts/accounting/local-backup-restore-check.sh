#!/usr/bin/env bash
# Backup → restore → verify, on LOCAL disposable databases only (no Neon, no production).
#   1. pg_dump (custom format) of the seeded local fixture database erp_finance_dev; SHA-256 recorded;
#   2. pg_restore into a fresh disposable database erp_finance_restore_check (marker comment set);
#   3. compare source and restored: row counts of every accounting table, ledger totals (entries,
#      debits, credits, balance per account), trigger and function inventories, e-invoice chain;
#   4. prove the restored copy still enforces the ledger rules: an update of a posted journal line
#      and of an issued e-invoice must be refused by their triggers (inside a rolled-back transaction);
#   5. drop the restore database.
#   bash scripts/accounting/local-backup-restore-check.sh <outDir>
# Exit 0 only if every comparison matches and both guard checks refuse. No URL or password is printed.
set -uo pipefail
OUT=${1:?out dir}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
case "$DATABASE_URL" in *@127.0.0.1:54329/erp_finance_dev*|*@localhost:54329/erp_finance_dev*) ;; *) echo "Refusing: DATABASE_URL is not the local erp_finance_dev"; exit 2;; esac
SRC="$DATABASE_URL"; RDB=erp_finance_restore_check
ADMIN=$(echo "$SRC" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#'); DST=$(echo "$SRC" | sed -E "s#/[^/?]+(\?.*)?\$#/$RDB\1#")
LOG="$OUT/backup-restore.txt"; : > "$LOG"
say() { echo "$*" | tee -a "$LOG"; }
say "started $(date -u +%FT%TZ); source database erp_finance_dev (local, disposable fixture)"
pg_dump -Fc --no-owner --no-acl -d "$SRC" -f "$OUT/erp_finance_dev.dump" 2> "$OUT/pg_dump.err" || { say "pg_dump failed"; exit 1; }
say "dump: $(du -h "$OUT/erp_finance_dev.dump" | cut -f1) sha256 $(sha256sum "$OUT/erp_finance_dev.dump" | cut -d' ' -f1)"
psql "$ADMIN" -qAt -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $RDB WITH (FORCE)" -c "CREATE DATABASE $RDB" -c "COMMENT ON DATABASE $RDB IS 'hiqbah-finance-disposable'" > /dev/null
pg_restore --no-owner --no-acl --exit-on-error -d "$DST" "$OUT/erp_finance_dev.dump" 2> "$OUT/pg_restore.err" || { say "pg_restore failed"; exit 1; }
say "restored into $RDB"
Q_COUNTS="select string_agg(t || '=' || n, ' ' order by t) from (select c.relname t, (xpath('/row/n/text()', query_to_xml(format('select count(*) n from %I', c.relname), false, true, '')))[1]::text n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r') x"
Q_LEDGER="select count(*) || ' journal lines, debit ' || coalesce(sum(l.debit),0) || ', credit ' || coalesce(sum(l.credit),0) || ', per-account md5 ' || md5(coalesce(string_agg(a.code || ':' || l.debit || ':' || l.credit, ',' order by l.id), '')) from \"JournalEntryLine\" l join \"Account\" a on a.id = l.\"accountId\""
Q_TRIG="select count(*) || ' triggers, md5 ' || md5(string_agg(tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text, ',' order by tgrelid::regclass::text, tgname)) from pg_trigger where not tgisinternal"
Q_FUNC="select count(*) || ' functions, md5 ' || md5(string_agg(p.proname || md5(pg_get_functiondef(p.oid)), ',' order by p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'"
Q_CHAIN="select count(*) || ' e-invoices, chain ' || coalesce(bool_and(case when icv = 1 then true else \"previousHash\" = lag_hash end), true) from (select icv, \"previousHash\", lag(\"invoiceHash\") over (partition by \"egsSerial\" order by icv) lag_hash from \"EInvoice\") x"
rc=0
for q in COUNTS LEDGER TRIG FUNC CHAIN; do
  v="Q_$q"; a=$(psql "$SRC" -qAt -v ON_ERROR_STOP=1 -c "${!v}" 2>&1); ea=$?; b=$(psql "$DST" -qAt -v ON_ERROR_STOP=1 -c "${!v}" 2>&1); eb=$?
  # A query error is a failure, never a "match" (two identical errors would otherwise compare equal).
  if [ $ea -ne 0 ] || [ $eb -ne 0 ] || [ -z "$a" ]; then say "$q: QUERY FAILED ($(echo "$a$b" | head -1 | cut -c1-160))"; rc=1; continue; fi
  if [ "$a" = "$b" ]; then say "$q: match ($(echo "$a" | cut -c1-120))"; else say "$q: MISMATCH"; say "  source:   $(echo "$a" | cut -c1-300)"; say "  restored: $(echo "$b" | cut -c1-300)"; rc=1; fi
done
g1=$(psql "$DST" -qAt -c "begin; update \"JournalEntryLine\" set debit = debit + 1 where \"journalEntryId\" in (select id from \"JournalEntry\" where status = 'POSTED' limit 1); rollback;" 2>&1)
if echo "$g1" | grep -qi "error"; then say "guard: posted journal line update refused in the restored copy ($(echo "$g1" | grep -i error | head -1 | cut -c1-140))"; else say "guard: posted journal line update was NOT refused"; rc=1; fi
g2=$(psql "$DST" -qAt -c "begin; update \"EInvoice\" set xml = '<x/>' where id in (select id from \"EInvoice\" limit 1); rollback;" 2>&1)
if [ "$(psql "$DST" -qAt -c 'select count(*) from "EInvoice"')" = "0" ]; then say "guard: no e-invoices to test"; elif echo "$g2" | grep -qi "error"; then say "guard: issued e-invoice update refused in the restored copy ($(echo "$g2" | grep -i error | head -1 | cut -c1-140))"; else say "guard: e-invoice update was NOT refused"; rc=1; fi
psql "$ADMIN" -qAt -c "DROP DATABASE IF EXISTS $RDB WITH (FORCE)" > /dev/null
rm -f "$OUT/erp_finance_dev.dump"   # synthetic data, but the dump itself is not evidence to keep
say "restore database dropped; result: $([ $rc -eq 0 ] && echo PASS || echo FAIL); finished $(date -u +%FT%TZ)"
sed -i -E 's#postgres(ql)?://[^ "]+#postgres://***#g' "$LOG" "$OUT"/*.err 2>/dev/null
exit $rc
