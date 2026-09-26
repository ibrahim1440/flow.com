#!/usr/bin/env bash
# Local migration rehearsal (isolated disposable databases on 127.0.0.1:54329 only).
#
#   bash scripts/finance/rehearsal/run-local-rehearsal.sh <candidate-worktree> <baseline-commit> <work-dir>
#
# 1. Baseline: a detached checkout of <baseline-commit> (the production commit) migrates a
#    fresh erp_rehearsal database with ITS OWN migrations, runs ITS OWN seed, then adds
#    synthetic volume. 2. Snapshot. 3. Backup = server-side copy erp_rehearsal_backup.
#    4. Candidate migrations applied with the repository's migrate-deploy command.
#    5. Post-checks: status, schema diff, preservation, triggers/constraints, runtime role.
#    6. Recovery: erp_rehearsal is dropped and recreated from the backup copy; verified equal
#    to the baseline. Nothing here can reach Neon: every URL is built for 127.0.0.1 and every
#    database name must start with erp_rehearsal.
set -euo pipefail
CAND="$1"; BASE_COMMIT="$2"; WORK="$3"
DB=erp_rehearsal; BACKUP=erp_rehearsal_backup
BASE="$WORK/rehearsal-base"
TOOL="node $CAND/scripts/finance/rehearsal/rehearsal-db.mjs"
mkdir -p "$WORK/out"; OUT="$WORK/out"
step() { echo; echo "== $*"; date +%T; }

step "0. baseline checkout of $BASE_COMMIT (detached, no .env)"
if [ ! -d "$BASE" ]; then git -C "$CAND" worktree add --detach "$BASE" "$BASE_COMMIT" >/dev/null; fi
git -C "$BASE" log --oneline -1
[ -e "$BASE/node_modules" ] || cmd //c mklink //J "$(cygpath -w "$BASE/node_modules")" "$(cygpath -w "$CAND/node_modules")" >/dev/null
cp "$CAND/scripts/finance/rehearsal/synthetic-baseline.ts.tmpl" "$BASE/scripts/rehearsal-synthetic-baseline.ts"
cp "$CAND/scripts/finance/rehearsal/old-client-compat.ts.tmpl" "$BASE/scripts/rehearsal-old-client-compat.ts"

step "1. fresh database, baseline migrations, baseline seed, synthetic volume"
$TOOL create $DB
$TOOL env $DB "$OUT/rehearsal.env"
set -a; . "$OUT/rehearsal.env"; set +a
# Random per run, never printed: the seed needs five distinct PINs for its employees.
rpin() { node -e 'console.log(require("crypto").randomInt(100000,999999))'; }
export ERP_SEED_ENABLED=true SEED_PIN_ADMIN=$(rpin) SEED_PIN_INVENTORY=$(rpin) SEED_PIN_ROASTING=$(rpin) SEED_PIN_QC=$(rpin) SEED_PIN_DISPATCH=$(rpin)
( cd "$BASE" && npx prisma generate >/dev/null 2>&1 && node scripts/migrate-deploy.mjs > "$OUT/base-deploy.log" 2>&1 ); grep -E "Applying migrations to|applied|No pending|Error" "$OUT/base-deploy.log" | tail -3 || true
( cd "$BASE" && npx tsx prisma/seed.ts 2>&1 | tail -1 )
( cd "$BASE" && npx tsx scripts/rehearsal-synthetic-baseline.ts )
( cd "$BASE" && npx prisma migrate status 2>&1 | tail -2 )

step "2. baseline snapshot"
$TOOL snapshot $DB "$OUT/baseline.json"

step "3. backup: server-side copy"
$TOOL copy $DB $BACKUP

step "4. candidate migrations (repository command)"
# The candidate checkout has its own .env; the exported URL must win. Confirm the target first.
# (migrate status exits 1 while migrations are pending, so read its output, not its exit code)
ST=$(cd "$CAND" && npx prisma migrate status 2>&1 || true)
echo "$ST" | grep -E 'database "' | grep -q '"erp_rehearsal"' || { echo "REFUSING: migrate status does not target erp_rehearsal"; exit 3; }
echo "$ST" | grep -iE "not yet been applied|following migration" | head -2 || true
echo "$ST" | grep -E "^[0-9]{14}_" || true
echo "target confirmed: erp_rehearsal on 127.0.0.1:54329"
( cd "$CAND" && node scripts/migrate-deploy.mjs > "$OUT/deploy.log" 2>&1 ); grep -E "Applying migrations to|^[0-9]{14}_|applied|Error" "$OUT/deploy.log" | tail -14 || true

step "5. post-checks"
( cd "$CAND" && npx prisma migrate status 2>&1 | tail -2 )
( cd "$CAND" && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script 2>/dev/null > "$OUT/diff.sql"; echo "schema diff lines: $(grep -cvE '^\s*$|^--' "$OUT/diff.sql" || true)"; head -5 "$OUT/diff.sql" )
$TOOL snapshot $DB "$OUT/after.json" "$OUT/baseline.json"
$TOOL compare "$OUT/baseline.json" "$OUT/after.json" | tee "$OUT/compare.json"
node -e '
const a=require(process.argv[1]);const need=["AllocationEntry_append_only","AllocationEntry_transfer_approval","AllocationRun_append_only","FinAuditLog_append_only","BankTransaction_no_delete","BudgetLine_protect_approved","BudgetRevision_protect_approved","BudgetRevision_four_eyes","AllocationRuleVersion_four_eyes","FinApprovalRequest_guard","PaymentReservation_override_approval","FinBudget_reopen_approval"];
const have=new Set(a.triggers.map(t=>t.trigger));const miss=need.filter(n=>!have.has(n));
const cols=a.tables.FinSettings.columns;const idx=a.indexes.map(i=>i.name);
console.log(JSON.stringify({requiredTriggersPresent:need.length-miss.length+"/"+need.length,missing:miss,allowSelfApprovalColumn:cols.includes("allowSelfApproval"),checkConstraints:a.constraints.filter(c=>c.type==="c"&&/^(Fin|Bank|Allocation|Budget|Payment|Cash)/.test(c.table)).length,collectionOnceIndexes:idx.filter(n=>/collection_once|_once/.test(n))},null,1));
if(miss.length||cols.includes("allowSelfApproval"))process.exit(2);' "$OUT/after.json"

step "5a. the production build (baseline commit) reads every model on the migrated schema"
( cd "$BASE" && npx tsx scripts/rehearsal-old-client-compat.ts ) | tee "$OUT/old-client-compat.json"

step "5b. runtime role (finance_app: DML only)"
$TOOL grant-app $DB
$TOOL role-checks $DB | tee "$OUT/role-checks.json"

step "6. recovery rehearsal: recreate from the backup copy, verify against the baseline"
$TOOL copy $BACKUP $DB
$TOOL snapshot $DB "$OUT/restored.json"
$TOOL compare "$OUT/baseline.json" "$OUT/restored.json" | tee "$OUT/restore-compare.json"
node -e 'const b=require(process.argv[1]),r=require(process.argv[2]);const same=JSON.stringify(b.migrations)===JSON.stringify(r.migrations)&&Object.keys(b.tables).length===Object.keys(r.tables).length;console.log(same?"restored database has exactly the baseline tables and migration list":"MISMATCH after restore");if(!same)process.exit(2);' "$OUT/baseline.json" "$OUT/restored.json"
echo; echo "== rehearsal complete"; date +%T
