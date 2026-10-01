#!/bin/bash
# SHA-bound local run of every accounting release gate that can run on this machine: type check,
# lint, build, unit/DB suites, HTTP suites and browser forms against `next start` as the restricted
# runtime role, captures, accessibility, Sales suites on a disposable sales_preview, the isolated
# year-end browser scenario, backend regression certification, and a secret scan of the evidence.
# Local PostgreSQL only (127.0.0.1:54329); refuses a dirty working tree. Secrets come from .env and
# are never printed; outputs are masked for database URLs before being stored as evidence in
# docs/accounting/evidence/test-runs/<sha>-*. External gates (ZATCA SDK/sandbox, Preview, Neon
# rehearsal, reviews, acceptance) are NOT covered — RELEASE_PROPOSAL.md.
#
#   bash scripts/accounting/local-release-gates.sh
set -u
cd "$(dirname "$0")/../.."
pg_isready -q -h 127.0.0.1 -p 54329 || { echo "PostgreSQL is not running"; exit 1; }
SHA=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
EV=docs/accounting/evidence/test-runs
TMP=${RUN_DIR:-/tmp/accounting-gates}/run-$SHA; mkdir -p $TMP
S=$TMP/summary.txt; echo "commit $(git rev-parse HEAD) start $(date -u +%FT%TZ)" > $S
mask() { sed -E 's#postgres(ql)?://[^ "]+#postgres://***#g'; }
step() { local name=$1; shift; "$@" > $TMP/$name.tap 2>&1; local rc=$?; local p=$(grep -E '^# pass' $TMP/$name.tap | tail -1); local f=$(grep -E '^# fail' $TMP/$name.tap | tail -1); echo "$name rc=$rc $p $f" | tee -a $S; }
step tsc npx tsc --noEmit -p .
step lint npx eslint src/lib/accounting src/app/api/accounting src/app/dashboard/accounting src/app/dashboard/finance/_components src/components/AccountingStatusChip.tsx tests/accounting scripts/accounting
step build npm run -s build
step acc-unit npm run -s test:accounting:unit
step acc-db npm run -s test:accounting:db
step acc-scripts npm run -s test:accounting:scripts
# ZATCA SDK harness tests (stub SDK; the container case runs only if Docker and the runner image exist).
step acc-harness npm run -s test:accounting:harness
step fin-unit npm run -s test:finance:unit
step fin-db npm run -s test:finance:db
# HTTP, capture and audit need the fixture credentials (after the DB suites, so .env never overrides .env.test).
set -a; . ./.env; set +a
H="env BASE_URL=http://localhost:3040 FIN_PASSWORD=$FIN_FIXTURE_PASSWORD RUNTIME_DATABASE_URL=$ACC_RUNTIME_DATABASE_URL node --test --test-concurrency=1"
reseed() { timeout 900 npx tsx --env-file=.env scripts/accounting/seed-local-fixture.ts --reset 2>&1 | grep -E "Accounting fixture|Error|Message" >> $TMP/reseed.log; }
PIDFILE=$TMP/server.pid
serve() { # next start as the runtime role accounting_app (DML only); $1 = --no-switch to leave provisional posting off
  [ -f $PIDFILE ] && kill "$(cat $PIDFILE)" 2>/dev/null && sleep 2
  # Never test against a server this run did not start (it could run other code or another configuration).
  if curl -s -o /dev/null http://localhost:3040/login; then echo "port 3040 is already served by another process; stop it first" | tee -a $S; exit 1; fi
  ( export DATABASE_URL="$ACC_RUNTIME_DATABASE_URL"; unset DIRECT_URL
    if [ "${1:-}" = "--no-switch" ]; then unset ACCOUNTING_PROVISIONAL_POSTING; else export ACCOUNTING_PROVISIONAL_POSTING=isolated-test; fi
    nohup node node_modules/next/dist/bin/next start -p 3040 > $TMP/server.log 2>&1 & echo $! > $PIDFILE )
  for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:3040/login && break; sleep 1; done
}
reseed; serve --no-switch
step http-no-switch $H tests/accounting/http/runtime-no-switch.test.mjs
reseed; serve
for t in authz runtime-workflow stage2-workflow bank-corrections receivables-workflow inventory-workflow ops-integration fixed-assets tax; do step http-$t $H tests/accounting/http/$t.test.mjs; done
reseed
step ops-forms env BASE_URL=http://localhost:3040 FIN_PASSWORD=$FIN_FIXTURE_PASSWORD RUNTIME_DATABASE_URL=$ACC_RUNTIME_DATABASE_URL PW_CHROMIUM=${PW_CHROMIUM:-/opt/pw-browsers/chromium} node tests/accounting/visual/ops-forms.mjs $TMP/shots
reseed
step ops-pack-dispatch env BASE_URL=http://localhost:3040 FIN_PASSWORD=$FIN_FIXTURE_PASSWORD RUNTIME_DATABASE_URL=$ACC_RUNTIME_DATABASE_URL PW_CHROMIUM=${PW_CHROMIUM:-/opt/pw-browsers/chromium} node tests/accounting/visual/ops-pack-dispatch.mjs $TMP/shots
reseed
step fa-forms env BASE_URL=http://localhost:3040 FIN_PASSWORD=$FIN_FIXTURE_PASSWORD RUNTIME_DATABASE_URL=$ACC_RUNTIME_DATABASE_URL PW_CHROMIUM=${PW_CHROMIUM:-/opt/pw-browsers/chromium} node tests/accounting/visual/fa-forms.mjs $TMP/shots
reseed
step tax-forms env BASE_URL=http://localhost:3040 FIN_PASSWORD=$FIN_FIXTURE_PASSWORD RUNTIME_DATABASE_URL=$ACC_RUNTIME_DATABASE_URL PW_CHROMIUM=${PW_CHROMIUM:-/opt/pw-browsers/chromium} node tests/accounting/visual/tax-forms.mjs $TMP/shots
step year-end-forms env PW_CHROMIUM=${PW_CHROMIUM:-/opt/pw-browsers/chromium} bash scripts/accounting/local-year-end-browser.sh $TMP/shots
reseed
step capture env BASE_URL=http://localhost:3040 FIN_PASSWORD=$FIN_FIXTURE_PASSWORD PW_CHROMIUM=${PW_CHROMIUM:-/opt/pw-browsers/chromium} node tests/accounting/visual/capture.mjs $TMP/shots
echo "capture pageErrors: $(grep -c '"pageErrors":\[\]' $TMP/capture.tap) clean of $(grep -c '"id"' $TMP/capture.tap); overflow true: $(grep -c '"pageOverflowX":true' $TMP/capture.tap)" | tee -a $S
step a11y env BASE_URL=http://localhost:3040 FIN_PASSWORD=$FIN_FIXTURE_PASSWORD PW_CHROMIUM=${PW_CHROMIUM:-/opt/pw-browsers/chromium} node tests/accounting/visual/a11y.mjs $TMP/a11y.json
grep "serious/critical" $TMP/a11y.tap | tee -a $S
kill "$(cat $PIDFILE)" 2>/dev/null
# Backup → restore → verify on local disposable databases (fixture reseeded first).
reseed
step backup-restore bash scripts/accounting/local-backup-restore-check.sh $TMP/backup-restore
# Sales: pure engine suites, and the DB suite on a fresh local disposable sales_preview (DML-only role).
step sales-pure node scripts/e2e/regression/run-sales.mjs commission-engine quotes-domain
ADMIN=$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')
SPDB=$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/sales_preview#')
APPPW=$(openssl rand -hex 16)
psql "$ADMIN" -qAt -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS sales_preview WITH (FORCE)" -c "CREATE DATABASE sales_preview" -c "COMMENT ON DATABASE sales_preview IS 'hiqbah-finance-disposable'" > /dev/null 2>&1
( DATABASE_URL="$SPDB" DIRECT_URL="$SPDB" npx prisma migrate deploy ) > $TMP/sales-migrate.log 2>&1 && echo "sales_preview migrated" | tee -a $S
psql "$SPDB" -qAt -v ON_ERROR_STOP=1 > /dev/null 2>&1 <<SQL
DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_preview_app') THEN CREATE ROLE sales_preview_app LOGIN; END IF; END \$\$;
ALTER ROLE sales_preview_app PASSWORD '$APPPW';
GRANT CONNECT ON DATABASE sales_preview TO sales_preview_app;
GRANT USAGE ON SCHEMA public TO sales_preview_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sales_preview_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sales_preview_app;
SQL
SPAPP=$(echo "$SPDB" | sed -E "s#//[^:]+:[^@]+@#//sales_preview_app:$APPPW@#")
step sales-db env DATABASE_URL="$SPAPP" node scripts/e2e/regression/sales-commissions-db.mjs
grep -hE "passed, [0-9]+ failed|GREEN|RED" $TMP/sales-pure.tap $TMP/sales-db.tap | tail -4 | tee -a $S
# Sales running-app suites against a fresh local sales_preview (app as the DML-only role).
step sales-app bash scripts/e2e/regression/local-sales-app-suites.sh $TMP/sales-app
cp $TMP/sales-app/sales-security.log $TMP/sales-security.tap; cp $TMP/sales-app/sales-workflow.log $TMP/sales-workflow.tap
grep -hE "^sales-(security|workflow):" $TMP/sales-app.tap | tee -a $S
# Backend regression certification from a clean worktree of this commit.
step certification node scripts/e2e/regression/local-certification.mjs $(git rev-parse HEAD)
grep -E "suite\(s\)|GREEN|RED" $TMP/certification.tap | tail -2 | tee -a $S
echo "end $(date -u +%FT%TZ)" >> $S
for f in $TMP/*.tap $S; do mask < $f > $EV/$SHA-$(basename $f); done
grep -l -F -e "$FIN_FIXTURE_PASSWORD" -e "$APPPW" $EV/$SHA-* && echo "SECRET FOUND" || echo "no fixture password in evidence"
